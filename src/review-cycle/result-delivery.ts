import type { Logger } from "../config/logging.js";
import { ContractError } from "./errors.js";
import type { ResultMessage, ReviewCycleLedger } from "./ledger.js";

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

export interface DeliveryDeps {
  ledger: ReviewCycleLedger;
  publisher: ResultPublisher;
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

/**
 * 期限が来た結果の通知を 1 回ずつ送る。成功は delivered、再送しても通らない拒否は rejected（再送しない）、
 * ACK 未受信などの再送可能な失敗は上限までバックオフして再送し、上限に達したら failed にする。
 * 認証・権限・schema 競合は自動で迂回しない（rejected として記録する）。
 */
export async function deliverDue(deps: DeliveryDeps): Promise<DeliveryReport> {
  const { ledger, publisher, logger } = deps;
  const settings = deps.settings ?? DEFAULT_DELIVERY_SETTINGS;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const report: DeliveryReport = { delivered: 0, retried: 0, rejected: 0, failed: 0 };

  for (const { message, attempts } of ledger.dueResultMessages()) {
    const ref = { cycleId: message.cycleId, resultVersion: message.resultVersion };
    try {
      await publisher.publish(message);
      ledger.markResultDelivered(message.cycleId, message.resultVersion);
      report.delivered++;
    } catch (error) {
      const contractError =
        error instanceof ContractError
          ? error
          : new ContractError("UNAVAILABLE", "結果の通知を送れなかった");
      if (!contractError.retryable) {
        ledger.markResultRejected(message.cycleId, message.resultVersion, contractError.code);
        logger.warn("internal.result.delivery.rejected", {
          event: "internal.result.delivery.rejected",
          ...ref,
          code: contractError.code,
        });
        report.rejected++;
        continue;
      }
      const attempt = attempts + 1;
      if (attempt >= settings.maxAttempts) {
        ledger.recordResultDeliveryFailure(message.cycleId, message.resultVersion, {
          code: contractError.code,
          nextAttemptAt: null,
        });
        logger.error("internal.result.delivery.failed", {
          event: "internal.result.delivery.failed",
          ...ref,
          code: contractError.code,
          attempts: attempt,
        });
        report.failed++;
      } else {
        ledger.recordResultDeliveryFailure(message.cycleId, message.resultVersion, {
          code: contractError.code,
          nextAttemptAt: new Date(now().getTime() + backoffMs(attempt, settings, random())),
        });
        report.retried++;
      }
    }
  }
  return report;
}

/**
 * 一定間隔で deliverDue を回す。signal が中断されたら止まる（実行中の 1 回は終わらせ、終わったら待たずに止まる）。
 */
export async function runDelivery(
  deps: DeliveryDeps,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
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
    await sleep(intervalMs, signal);
  }
}

/** ms 待つ。signal が中断されたら即座に戻る。満了・中断のどちらでも listener とタイマーを残さない。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
