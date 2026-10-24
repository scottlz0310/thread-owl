import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../config/logging.js";
import type { ToolDeps } from "../mcp/tool-deps.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import type { ReviewStatusStore } from "../queue/review-status.js";
import type { InternalSurfaceConfig } from "./config.js";
import { type CandidateIngest, createLedgerIngest } from "./ingest.js";
import { createInternalEndpoint } from "./internal-endpoint.js";
import { ReviewCycleLedger } from "./ledger.js";
import { createOriginChecker } from "./origin.js";
import { RavenClient } from "./raven-client.js";
import { ResultBinder } from "./result-binder.js";
import { runDelivery } from "./result-delivery.js";
import { purgeOnce, runRetention } from "./retention.js";

export interface InternalSurface {
  /** 公開の投稿 tool の candidateId 束縛に渡す。 */
  binder: ResultBinder;
  /** webhook・コメント由来の候補を review-raven の共通受付へ渡す記録。配送を設定したときだけ。 */
  ingest: CandidateIngest | undefined;
  /** 内部面のパスなら処理して true を返す。公開面の HTTP server の fallbackHandler から呼ぶ。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * 再起動で失われた in-memory queue を、台帳の「受付済みで未起動・未取消」の候補から再構築する。
 * 旧経路の queue 項目は永続していないため、再構築の対象外。
 */
export function restoreQueue(
  ledger: ReviewCycleLedger,
  queue: ReviewQueue,
  reviewStatus?: ReviewStatusStore,
  binder?: ResultBinder,
): number {
  const queued = ledger.listQueued();
  for (const candidate of queued) {
    queue.enqueue({
      owner: candidate.owner,
      repo: candidate.repo,
      prNumber: candidate.prNumber,
      installationId: candidate.installationId,
      queuedAt: new Date(candidate.acceptedAt),
      reason: candidate.reason,
      cycle: {
        candidateId: candidate.candidateId,
        cycleId: candidate.cycleId,
        round: candidate.round,
        headSha: candidate.headSha,
      },
    });
    reviewStatus?.markPending(candidate);
    binder?.noteStatusRound(candidate.cycleId, candidate);
  }
  return queued.length;
}

/** 永続台帳を開き、内部 MCP 面（公開面とは別のパス・別の MCP server）を作る。 */
export function startInternalSurface(
  config: InternalSurfaceConfig,
  tools: Pick<ToolDeps, "getClient" | "allowedRepos" | "allowedAuthors" | "resolveInstallationId">,
  runtime: {
    queue: ReviewQueue;
    reviewStatus?: ReviewStatusStore;
    /** thread-owl 自身の投稿者（例: `thread-owl[bot]`）。結果の照合で、他者のマーカーを信用しないために使う。 */
    botLogin: string;
  },
  logger: Logger,
  version: string,
): InternalSurface {
  const ledger = new ReviewCycleLedger({ path: config.ledgerPath });
  const binder = new ResultBinder({
    ledger,
    queue: runtime.queue,
    reviewStatus: runtime.reviewStatus,
    getClient: tools.getClient,
    botLogin: runtime.botLogin,
    logger,
  });
  // 期限を過ぎた候補は、queue を復元する前に台帳から削除する（削除済みの候補を配信対象に載せない）。
  const onPurged = (cycleIds: string[]) => {
    for (const cycleId of cycleIds) {
      runtime.queue.removeCycle(cycleId);
    }
  };
  purgeOnce({ ledger, retentionDays: config.retentionDays, logger, onPurged });
  const restored = restoreQueue(ledger, runtime.queue, runtime.reviewStatus, binder);
  if (restored > 0) {
    logger.info("internal.queue.restored", { event: "internal.queue.restored", count: restored });
  }
  const endpoint = createInternalEndpoint({
    path: config.path,
    proxySecret: config.proxySecret,
    version,
    deps: {
      ledger,
      acl: config.serviceAcl,
      checkOrigin: createOriginChecker({ ...tools, logger }),
      queue: runtime.queue,
      reviewStatus: runtime.reviewStatus,
      resolveInstallationId: tools.resolveInstallationId,
      binder,
      logger,
    },
    onError: (error) => {
      logger.error("internal.mcp.request.error", {
        event: "internal.mcp.request.error",
        errorName: error.name,
      });
    },
  });
  // 結果を review-raven へ送る worker（配送を設定したときだけ）。止めるときは、実行中の 1 回を終えてから台帳を閉じる。
  const stopDelivery = new AbortController();
  const raven = config.delivery
    ? new RavenClient({ endpoint: config.delivery.endpoint, token: config.delivery.token })
    : undefined;
  const worker =
    raven && config.delivery
      ? runDelivery(
          { ledger, publisher: raven, ingester: raven, logger },
          config.delivery.intervalMs,
          stopDelivery.signal,
        )
      : Promise.resolve();
  // 保持期限を過ぎた行の削除（起動時と、以後一定間隔）。
  const retention = runRetention(
    { ledger, retentionDays: config.retentionDays, logger, onPurged },
    stopDelivery.signal,
  );
  if (config.delivery) {
    logger.info("internal.result.delivery.started", {
      event: "internal.result.delivery.started",
      endpoint: config.delivery.endpoint,
      intervalMs: config.delivery.intervalMs,
    });
  }
  return {
    binder,
    ingest: config.delivery ? createLedgerIngest(ledger, logger) : undefined,
    handle: (req, res) => endpoint.handle(req, res),
    close: async () => {
      stopDelivery.abort();
      try {
        await Promise.all([worker, retention]);
        await endpoint.close();
      } finally {
        ledger.close();
      }
    },
  };
}
