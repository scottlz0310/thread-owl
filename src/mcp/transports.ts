import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type McpServerFactory,
  type ServerNotifier,
  type Transport,
} from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";

export interface McpHttpServerOptions {
  host: string;
  port: number;
  path?: string;
  onError?: (error: Error) => void;
  /** MCP パス以外のリクエストを処理するハンドラ。未指定時は 404 を返す。combined モードで使用。 */
  fallbackHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

export interface StartedMcpHttpServer {
  host: string;
  port: number;
  path: string;
  /** subscriptions/listen で開いている全 stream へ resource 更新を配信する。 */
  notify: ServerNotifier;
  close(): Promise<void>;
}

export function startMcpStdioServer(
  factory: McpServerFactory,
  transport?: Transport,
): StdioServerHandle {
  return serveStdio(factory, { legacy: "reject", transport });
}

export async function startMcpHttpServer(
  factory: McpServerFactory,
  options: McpHttpServerOptions,
): Promise<StartedMcpHttpServer> {
  const path = options.path ?? "/mcp";
  const normalizedPath = normalizeEndpointPath(path);

  const handler = createMcpHandler(factory, {
    legacy: "reject",
    onerror: options.onError,
  });
  const nodeHandler = toNodeHandler(handler);

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
    // subscriptions/listen の long-lived SSE stream をリバースプロキシ（mcp-gateway 等）に
    // バッファリングさせないための推奨ヘッダー。JSON レスポンスに付いても無害。
    res.setHeader("X-Accel-Buffering", "no");
    await nodeHandler(req, res);
  };

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      options.onError?.(err);
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
    notify: handler.notify,
    close: () => {
      closing ??= (async () => {
        const errors: unknown[] = [];
        try {
          await handler.close();
        } catch (error) {
          errors.push(error);
        }
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
