import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../config/logging.js";

export type McpServerFactory = () => McpServer;

export interface McpHttpServerOptions {
  host: string;
  port: number;
  path?: string;
  onError?: (error: unknown) => void;
  /** MCP パス以外のリクエストを処理するハンドラ。未指定時は 404 を返す。combined モードで使用。 */
  fallbackHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** 渡すとセッションの作成・削除のたびに現在のセッション数をログする（#117 診断用）。 */
  logger?: Logger;
}

export interface StartedMcpHttpServer {
  host: string;
  port: number;
  path: string;
  close(): Promise<void>;
}

interface McpHttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export async function startMcpStdioServer(
  server: McpServer,
  transport: Transport = new StdioServerTransport(),
): Promise<void> {
  await server.connect(transport);
}

export async function startMcpHttpServer(
  createMcpServer: McpServerFactory,
  options: McpHttpServerOptions,
): Promise<StartedMcpHttpServer> {
  const path = options.path ?? "/mcp";
  const normalizedPath = normalizeEndpointPath(path);
  const sessions = new Map<string, McpHttpSession>();

  // 通知配信の長時間稼働後サイレント停止（#117）の診断用。セッション数の推移を追える。
  const logSessionCount = (event: string) => {
    options.logger?.debug(event, { event, sessionCount: sessions.size });
  };

  const closeSession = async (session: McpHttpSession) => {
    const sessionId = session.transport.sessionId;
    if (sessionId && sessions.get(sessionId) === session) {
      sessions.delete(sessionId);
      logSessionCount("mcp.session.closed");
    }
    if (session.server.isConnected()) {
      await session.server.close();
    } else {
      await session.transport.close();
    }
  };

  const createSession = async (): Promise<McpHttpSession> => {
    const server = createMcpServer();
    let session: McpHttpSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, session);
        logSessionCount("mcp.session.initialized");
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
        logSessionCount("mcp.session.closed");
      },
    });
    session = { server, transport };

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId && sessions.get(sessionId) === session) {
        sessions.delete(sessionId);
        logSessionCount("mcp.session.closed");
      }
    };

    try {
      await server.connect(transport);
      return session;
    } catch (error) {
      await closeSession(session);
      throw error;
    }
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    if (normalizeEndpointPath(requestPath) !== normalizedPath) {
      if (options.fallbackHandler) {
        await options.fallbackHandler(req, res);
      } else {
        res.writeHead(404).end();
      }
      return;
    }

    const sessionId = getSessionId(req);
    let session = sessionId ? sessions.get(sessionId) : undefined;
    let parsedBody: unknown;

    if (sessionId && !session) {
      writeJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }

    if (req.method === "POST" && !session) {
      try {
        parsedBody = await json(req);
      } catch {
        writeJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
        return;
      }

      if (!isInitializeRequest(parsedBody)) {
        writeJsonRpcError(res, 400, -32000, "Mcp-Session-Id is required");
        return;
      }

      session = await createSession();
    } else if (!session) {
      writeJsonRpcError(res, 400, -32000, "Mcp-Session-Id is required");
      return;
    }

    try {
      await session.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      await closeSession(session);
      throw error;
    }
  };

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      options.onError?.(error);
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.destroy();
      }
    });
  });

  await listen(httpServer, options.host, options.port);
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("MCP HTTP server did not expose a TCP address");
  }

  let closing: Promise<void> | undefined;
  return {
    host: options.host,
    port: address.port,
    path,
    close: () => {
      closing ??= (async () => {
        const results = await Promise.allSettled([...sessions.values()].map(closeSession));
        sessions.clear();
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        try {
          await closeHttpServer(httpServer);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "Failed to close MCP HTTP server");
        }
      })();
      return closing;
    },
  };
}

function normalizeEndpointPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function getSessionId(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? undefined : value;
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    server.closeAllConnections();
  });
}
