import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  type CallToolResult,
  createMcpHandler,
  fromJsonSchema,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  McpServer,
} from "@modelcontextprotocol/server";
import { contractJsonSchema } from "../contract/validate.js";
import {
  callInternalTool,
  INTERNAL_TOOLS,
  type InternalToolDeps,
  type InternalToolName,
} from "./internal-tools.js";

const TOOL_DESCRIPTIONS: Record<InternalToolName, string> = {
  accept_review_candidate:
    "review-raven から、レビュー依頼の候補を受け付ける（cycle・round・HEAD を固定し、同じ内容の再送は同じ candidateId を返す）",
  cancel_review_candidate:
    "review-raven から、旧候補を無効化する。GitHub 書込みが進行中・結果不明の間は ACK を返さない",
  get_review_result:
    "review-raven から、cycle の結果（GitHub 投稿への参照）を取得する。本文・Verdict は返さない",
};

// 入力の検証は契約 schema（callInternalTool）で行い、不正は契約のエラー envelope で返す。
// SDK 側の検証が先に失敗すると envelope にならないため、SDK には通すだけにして、通知する schema だけを使う。
const passThroughValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

function toResult(outcome: Awaited<ReturnType<typeof callInternalTool>>): CallToolResult {
  const body = outcome.ok ? outcome.output : outcome.envelope;
  return {
    ...(outcome.ok ? {} : { isError: true }),
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

const principals = new AsyncLocalStorage<string>();

function createInternalMcpServer(deps: InternalToolDeps, version: string): McpServer {
  const server = new McpServer({ name: "thread-owl-internal", version });
  for (const [name, tool] of Object.entries(INTERNAL_TOOLS) as [
    InternalToolName,
    (typeof INTERNAL_TOOLS)[InternalToolName],
  ][]) {
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: fromJsonSchema(contractJsonSchema(tool.input), passThroughValidator),
      },
      async (args) => {
        const principal = principals.getStore();
        if (principal === undefined) {
          throw new Error("認証済みのサービス主体が無い");
        }
        return toResult(await callInternalTool(deps, principal, name, args));
      },
    );
  }
  return server;
}

export type InternalAuthResult =
  | { ok: true; principal: string }
  | { ok: false; code: "missing_proxy_identity" | "invalid_proxy_token" };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * gateway が付けた identity（X-Authenticated-User）と、gateway と共有する proxy secret
 * （Authorization: Bearer）を検証する。identity は自己申告の入力ではなく、サービス主体の根拠。
 */
export function authenticateInternalRequest(
  headers: IncomingHttpHeaders,
  proxySecret: string,
): InternalAuthResult {
  const identity = headers["x-authenticated-user"];
  if (typeof identity !== "string" || identity.trim() === "") {
    return { ok: false, code: "missing_proxy_identity" };
  }
  const authorization = headers.authorization;
  const token =
    typeof authorization === "string" && /^Bearer /i.test(authorization)
      ? authorization.slice("Bearer ".length).trim()
      : "";
  if (proxySecret === "" || !timingSafeEqual(digest(token), digest(proxySecret))) {
    return { ok: false, code: "invalid_proxy_token" };
  }
  return { ok: true, principal: identity.trim() };
}

export interface InternalEndpointOptions {
  /** 公開の MCP パスとは別の、内部面専用のパス。 */
  path: string;
  proxySecret: string;
  deps: InternalToolDeps;
  version: string;
  onError?: (error: Error) => void;
}

export interface InternalEndpoint {
  /** 内部面のパスなら処理して true を返す。それ以外は false（呼び出し側が続きを処理する）。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

export function createInternalEndpoint(options: InternalEndpointOptions): InternalEndpoint {
  const handler = createMcpHandler(() => createInternalMcpServer(options.deps, options.version), {
    legacy: "reject",
    onerror: options.onError,
  });
  const nodeHandler = toNodeHandler(handler);

  return {
    async handle(req, res) {
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      if (requestPath.replace(/\/$/, "") !== options.path) {
        return false;
      }
      const auth = authenticateInternalRequest(req.headers, options.proxySecret);
      if (!auth.ok) {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="thread-owl-internal"',
        });
        res.end(JSON.stringify({ error: auth.code }));
        return true;
      }
      res.setHeader("X-Accel-Buffering", "no");
      await principals.run(auth.principal, () => nodeHandler(req, res));
      return true;
    },
    close: () => handler.close(),
  };
}
