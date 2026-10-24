import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../config/logging.js";
import type { ToolDeps } from "../mcp/tool-deps.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import type { ReviewStatusStore } from "../queue/review-status.js";
import type { InternalSurfaceConfig } from "./config.js";
import { createInternalEndpoint } from "./internal-endpoint.js";
import { ReviewCycleLedger } from "./ledger.js";
import { createOriginChecker } from "./origin.js";

export interface InternalSurface {
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
  }
  return queued.length;
}

/** 永続台帳を開き、内部 MCP 面（公開面とは別のパス・別の MCP server）を作る。 */
export function startInternalSurface(
  config: InternalSurfaceConfig,
  tools: Pick<ToolDeps, "getClient" | "allowedRepos" | "allowedAuthors" | "resolveInstallationId">,
  runtime: { queue: ReviewQueue; reviewStatus?: ReviewStatusStore },
  logger: Logger,
  version: string,
): InternalSurface {
  const ledger = new ReviewCycleLedger({ path: config.ledgerPath });
  const restored = restoreQueue(ledger, runtime.queue, runtime.reviewStatus);
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
      logger,
    },
    onError: (error) => {
      logger.error("internal.mcp.request.error", {
        event: "internal.mcp.request.error",
        errorName: error.name,
      });
    },
  });
  return {
    handle: (req, res) => endpoint.handle(req, res),
    close: async () => {
      try {
        await endpoint.close();
      } finally {
        ledger.close();
      }
    },
  };
}
