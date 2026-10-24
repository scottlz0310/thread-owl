import type { Logger } from "../config/logging.js";
import { abortableSleep } from "./abortable-sleep.js";
import { ContractError } from "./errors.js";
import type { IngestMessage, ResultMessage, ReviewCycleLedger } from "./ledger.js";

/** 配送の再送ポリシー。既定は契約の設定（fixtures/settings/valid/defaults.json）と同じ。 */
export interface DeliverySettings {
  maxAttempts: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  jitterRatio: number;
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  maxAttempts: 8,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60000,
  jitterRatio: 0.2,
};

/** 結果の通知の送信先（review-raven の publish_review_result）。失敗は ContractError で投げる。 */
export interface ResultPublisher {
  publish(message: ResultMessage): Promise<void>;
}

/** webhook・コメント由来の候補の送信先（review-raven の ingest_review_candidate）。失敗は ContractError で投げる。 */
export interface IngestPublisher {
  ingest(message: IngestMessage): Promise<void>;
}

export interface DeliveryDeps {
  ledger: ReviewCycleLedger;
  publisher: ResultPublisher;
  /** 渡すと、webhook・コメント由来の候補も送る。 */
  ingester?: IngestPublisher;
  settings?: DeliverySettings;
  logger: Logger;
  now?: () => Date;
  /** ジッタの乱数（0 以上 1 未満）。テストで固定する。 */
  random?: () => number;
}

export interface DeliveryReport {
  delivered: number;
  retried: number;
  rejected: number;
  failed: number;
}

/** n 回目の失敗の後の待ち時間。指数で増やし、上限で止め、ジッタを掛ける。 */
export function backoffMs(attempt: number, settings: DeliverySettings, random: number): number {
  const base = Math.min(
    settings.maxBackoffMs,
    settings.initialBackoffMs * settings.backoffMultiplier ** (attempt - 1),
  );
  return Math.round(base * (1 + settings.jitterRatio * (2 * random - 1)));
}

/** outbox の 1 種類（結果・候補）を送るための、台帳と送信先の対応。 */
interface OutboxSpec<T> {
  label: "result" | "ingest";
  due(): Array<{ message: T; attempts: number }>;
  send(message: T): Promise<void>;
  delivered(message: T): void;
  rejected(message: T, code: string): void;
  failure(message: T, failure: { code: string; nextAttemptAt: Date | null }): void;
  /** ログに残す識別子（本文・資格情報は含めない）。 */
  ref(message: T): Record<string, unknown>;
}

/**
 * 期限が来た通知を 1 回ずつ送る。成功は delivered、再送しても通らない拒否は rejected（再送しない）、
 * ACK 未受信などの再送可能な失敗は上限までバックオフして再送し、上限に達したら failed にする。
 * 認証・権限・schema 競合は自動で迂回しない（rejected として記録する）。
 */
async function deliverOutbox<T>(spec: OutboxSpec<T>, deps: DeliveryDeps): Promise<DeliveryReport> {
  const { logger } = deps;
  const settings = deps.settings ?? DEFAULT_DELIVERY_SETTINGS;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const report: DeliveryReport = { delivered: 0, retried: 0, rejected: 0, failed: 0 };

  for (const { message, attempts } of spec.due()) {
    try {
      await spec.send(message);
      spec.delivered(message);
      report.delivered++;
    } catch (error) {
      const contractError =
        error instanceof ContractError
          ? error
          : new ContractError("UNAVAILABLE", "通知を送れなかった");
      if (!contractError.retryable) {
        spec.rejected(message, contractError.code);
        logger.warn(`internal.${spec.label}.delivery.rejected`, {
          event: `internal.${spec.label}.delivery.rejected`,
          ...spec.ref(message),
          code: contractError.code,
        });
        report.rejected++;
        continue;
      }
      const attempt = attempts + 1;
      if (attempt >= settings.maxAttempts) {
        spec.failure(message, { code: contractError.code, nextAttemptAt: null });
        logger.error(`internal.${spec.label}.delivery.failed`, {
          event: `internal.${spec.label}.delivery.failed`,
          ...spec.ref(message),
          code: contractError.code,
          attempts: attempt,
        });
        report.failed++;
      } else {
        spec.failure(message, {
          code: contractError.code,
          nextAttemptAt: new Date(now().getTime() + backoffMs(attempt, settings, random())),
        });
        report.retried++;
      }
    }
  }
  return report;
}

/** 期限が来た結果の通知を送る。 */
export function deliverDue(deps: DeliveryDeps): Promise<DeliveryReport> {
  const { ledger, publisher } = deps;
  return deliverOutbox<ResultMessage>(
    {
      label: "result",
      due: () => ledger.dueResultMessages(),
      send: (message) => publisher.publish(message),
      delivered: (m) => ledger.markResultDelivered(m.cycleId, m.resultVersion),
      rejected: (m, code) => ledger.markResultRejected(m.cycleId, m.resultVersion, code),
      failure: (m, failure) =>
        ledger.recordResultDeliveryFailure(m.cycleId, m.resultVersion, failure),
      ref: (m) => ({ cycleId: m.cycleId, resultVersion: m.resultVersion }),
    },
    deps,
  );
}

/** 期限が来た、webhook・コメント由来の候補の通知を送る（ingester が無ければ何もしない）。 */
export async function deliverIngestDue(deps: DeliveryDeps): Promise<DeliveryReport> {
  const { ledger, ingester } = deps;
  if (!ingester) {
    return { delivered: 0, retried: 0, rejected: 0, failed: 0 };
  }
  return deliverOutbox<IngestMessage>(
    {
      label: "ingest",
      due: () => ledger.dueIngestMessages(),
      send: (message) => ingester.ingest(message),
      delivered: (m) => ledger.markIngestDelivered(m.sourceId),
      rejected: (m, code) => ledger.markIngestRejected(m.sourceId, code),
      failure: (m, failure) => ledger.recordIngestDeliveryFailure(m.sourceId, failure),
      ref: (m) => ({ sourceId: m.sourceId }),
    },
    deps,
  );
}

/**
 * 一定間隔で配送を回す。signal が中断されたら止まる（実行中の 1 回は終わらせ、終わったら待たずに止まる）。
 */
export async function runDelivery(
  deps: DeliveryDeps,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      // 候補の通知を先に送る（raven が cycle を作り、候補を送り返し、結果の通知の宛先ができる）。
      await deliverIngestDue(deps);
      await deliverDue(deps);
    } catch (error) {
      // 台帳の読み書きの失敗など。worker は止めず、次の周期で再試行する。
      deps.logger.error("internal.result.delivery.error", {
        event: "internal.result.delivery.error",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
    // 配送の最中に中断された場合、AbortSignal は過去の中断を再通知しないため、待機に入る前に確認する。
    if (signal.aborted) {
      return;
    }
    await abortableSleep(intervalMs, signal);
  }
}
