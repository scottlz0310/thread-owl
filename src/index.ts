// Thread Owl - application entry point

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { generateAppJwt } from "./app-auth/app-jwt.js";
import {
  InstallationNotFoundError,
  resolveInstallationId,
} from "./app-auth/installation-resolver.js";
import { getInstallationToken } from "./app-auth/installation-token.js";
import { createTokenCache } from "./app-auth/token-cache.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./config/logging.js";
import { getHealth } from "./internal-api/health.js";
import { getStatus } from "./internal-api/status.js";
import { type IssueTokenDeps, issueToken } from "./internal-api/token-source.js";
import { createMcpServer } from "./mcp/server.js";
import { buildToolDeps } from "./mcp/tool-deps.js";
import { startMcpHttpServer, startMcpStdioServer } from "./mcp/transports.js";
import { RepositoryNotAllowedError } from "./policy/allowlist.js";
import { createDeliveryDedup } from "./queue/delivery-dedup.js";
import { createReviewQueue } from "./queue/review-queue.js";
import { createSharedRuntime } from "./runtime/shared.js";
import { resolveAppMode } from "./startup/mode.js";
import { createWebhookReceiver } from "./webhook/receiver.js";

const VERSION = "0.3.0";

const mode = resolveAppMode(process.argv.slice(2));
const config = loadEnv();
// MCP stdio モードでは stdout が JSON-RPC 専用のため、ログは stderr に出す。
const logger = createLogger(
  config.logging.level,
  mode === "mcp-stdio" ? (line) => console.error(line) : undefined,
);
const tokenCache = createTokenCache();

const issueTokenDeps: IssueTokenDeps = {
  config,
  logger,
  tokenCache,
  generateAppJwt,
  resolveInstallationId,
  getInstallationToken,
};

const createConfiguredMcpServer = () =>
  createMcpServer(buildToolDeps(issueTokenDeps), {
    name: "thread-owl",
    version: VERSION,
  });

if (mode === "mcp-stdio") {
  const server = createConfiguredMcpServer();
  await startMcpStdioServer(server);
  logger.info("mcp.started", { event: "mcp.started", transport: "stdio" });
} else if (mode === "mcp-http") {
  // webhook receiver は起動しないため、GitHub イベントからの自動 enqueue は行わない。
  // enqueue_review tool と resources/subscribe のみで queue 機能を提供する（#122）。
  const reviewQueue = createReviewQueue();
  const httpServer = await startMcpHttpServer(
    () =>
      createMcpServer(
        { ...buildToolDeps(issueTokenDeps), queue: reviewQueue, logger },
        { name: "thread-owl", version: VERSION },
      ),
    {
      host: config.server.host,
      port: config.server.port,
      path: config.server.mcpHttpPath,
      logger,
      onError: (error) => {
        logger.error("mcp.request.error", {
          event: "mcp.request.error",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      },
    },
  );
  logger.info("mcp.started", {
    event: "mcp.started",
    transport: "streamable-http",
    host: httpServer.host,
    port: httpServer.port,
    path: httpServer.path,
  });

  const shutdown = () => {
    void httpServer.close().catch((error) => {
      logger.error("mcp.shutdown.error", {
        event: "mcp.shutdown.error",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} else if (mode === "internal-api") {
  const startedAt = new Date();

  const tokenQuerySchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  });

  const app = new Hono();

  app.get("/health", (c) => c.json(getHealth()));

  app.get("/status", (c) =>
    c.json(getStatus({ appId: config.github.appId, version: VERSION, startedAt })),
  );

  // /token は installation token（secret）を返す。Phase 1 では allowlist のみをゲートとし、
  // host 既定 127.0.0.1 の localhost bind 前提で運用する。
  // 将来 HTTP 公開する場合は allowlist とは別に caller 認証（API key 等）を必須にすること。
  app.get("/token", async (c) => {
    const parsed = tokenQuerySchema.safeParse({
      owner: c.req.query("owner"),
      repo: c.req.query("repo"),
    });
    if (!parsed.success) {
      return c.json({ error: "owner and repo query parameters are required" }, 400);
    }

    try {
      const result = await issueToken(parsed.data, issueTokenDeps);
      return c.json(result);
    } catch (error) {
      if (error instanceof RepositoryNotAllowedError) {
        return c.json({ error: "repository is not allowed" }, 403);
      }
      if (error instanceof InstallationNotFoundError) {
        return c.json({ error: "GitHub App is not installed on the repository" }, 404);
      }
      // secret 混入を避けるため errorName のみログ出力する
      logger.error("token.error", {
        event: "token.error",
        owner: parsed.data.owner,
        repo: parsed.data.repo,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return c.json({ error: "failed to issue installation token" }, 500);
    }
  });

  serve({ fetch: app.fetch, hostname: config.server.host, port: config.server.port });
  logger.info("server.started", {
    event: "server.started",
    host: config.server.host,
    port: config.server.port,
  });
} else if (mode === "webhook") {
  const webhookSecret = config.github.webhookSecret;
  if (!webhookSecret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required for --webhook mode");
  }

  const webhookApp = new Hono();
  webhookApp.get("/health", (c) => c.json(getHealth()));
  webhookApp.route(
    "/",
    createWebhookReceiver({
      secret: webhookSecret,
      appSlug: config.appSlug,
      dedup: createDeliveryDedup(),
      queue: createReviewQueue(),
      logger,
      allowedRepos: config.policy.allowedRepos,
    }),
  );

  serve({ fetch: webhookApp.fetch, hostname: config.server.host, port: config.server.port });
  logger.info("webhook.server.started", {
    event: "webhook.server.started",
    host: config.server.host,
    port: config.server.port,
  });
} else {
  // mode === "webhook-mcp-http"
  const webhookSecret = config.github.webhookSecret;
  if (!webhookSecret) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required for --webhook-mcp-http mode");
  }

  const runtime = createSharedRuntime(config, logger);
  const startedAt = new Date();

  const honoApp = new Hono();
  honoApp.get("/health", (c) => c.json(getHealth()));
  honoApp.get("/status", (c) =>
    c.json(getStatus({ appId: config.github.appId, version: VERSION, startedAt })),
  );
  honoApp.route(
    "/",
    createWebhookReceiver({
      secret: webhookSecret,
      appSlug: config.appSlug,
      dedup: runtime.deliveryDedup,
      queue: runtime.reviewQueue,
      logger,
      allowedRepos: config.policy.allowedRepos,
    }),
  );

  const { getRequestListener } = await import("@hono/node-server");
  const honoHandler = getRequestListener(honoApp.fetch);

  const httpServer = await startMcpHttpServer(
    () =>
      createMcpServer(
        { ...buildToolDeps(runtime.issueTokenDeps), queue: runtime.reviewQueue, logger },
        { name: "thread-owl", version: VERSION },
      ),
    {
      host: config.server.host,
      port: config.server.port,
      path: config.server.mcpHttpPath,
      logger,
      onError: (error) => {
        logger.error("mcp.request.error", {
          event: "mcp.request.error",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      },
      fallbackHandler: async (req, res) => {
        await honoHandler(req, res);
      },
    },
  );

  logger.info("webhook-mcp-http.started", {
    event: "webhook-mcp-http.started",
    host: httpServer.host,
    port: httpServer.port,
    mcpPath: httpServer.path,
  });

  const shutdown = () => {
    void httpServer.close().catch((error) => {
      logger.error("mcp.shutdown.error", {
        event: "mcp.shutdown.error",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
