import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../config/logging.js";
import type { ToolDeps } from "../mcp/tool-deps.js";
import type { InternalSurfaceConfig } from "./config.js";
import { createInternalEndpoint } from "./internal-endpoint.js";
import { ReviewCycleLedger } from "./ledger.js";
import { createOriginChecker } from "./origin.js";

export interface InternalSurface {
  /** 内部面のパスなら処理して true を返す。公開面の HTTP server の fallbackHandler から呼ぶ。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

/** 永続台帳を開き、内部 MCP 面（公開面とは別のパス・別の MCP server）を作る。 */
export function startInternalSurface(
  config: InternalSurfaceConfig,
  tools: Pick<ToolDeps, "getClient" | "allowedRepos" | "allowedAuthors">,
  logger: Logger,
  version: string,
): InternalSurface {
  const ledger = new ReviewCycleLedger({ path: config.ledgerPath });
  const endpoint = createInternalEndpoint({
    path: config.path,
    proxySecret: config.proxySecret,
    version,
    deps: {
      ledger,
      acl: config.serviceAcl,
      checkOrigin: createOriginChecker({ ...tools, logger }),
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
