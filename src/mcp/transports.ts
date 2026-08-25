import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type McpServerFactory,
  type ServerNotifier,
  type Transport,
} from "@modelcontextprotocol/server";
import {
  type StdioServerHandle,
  StdioServerTransport,
  serveStdio,
} from "@modelcontextprotocol/server/stdio";

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

export interface McpStdioServerOptions {
  transport?: Transport;
  /**
   * transport.start() が reject した場合にのみ呼ばれる（起動失敗の fatal 通知）。
   * serveStdio 自身の onerror は out-of-band error 全般（legacy 拒否など正常系の
   * プロトコルエラー応答を書き出す直前にも発火する）の reporting 用であり、
   * 起動失敗専用ではないため、fatal 判定にはこちらではなく本オプションを使う。
   */
  onStartError?: (error: Error) => void;
  /** serveStdio の out-of-band error 全般を報告する（reporting only、致命的ではない）。 */
  onError?: (error: Error) => void;
}

export function startMcpStdioServer(
  factory: McpServerFactory,
  options?: McpStdioServerOptions,
): StdioServerHandle {
  const transport = wrapTransportStart(
    options?.transport ?? new StdioServerTransport(),
    options?.onStartError,
  );
  return serveStdio(factory, {
    legacy: "reject",
    transport,
    onerror: options?.onError,
  });
}

// transport.start() の失敗だけを onStartError で報告する薄い委譲ラッパー。
// serveStdio の onerror に一本化すると、legacy 拒否応答の書き込み直前にも
// 同じコールバックが呼ばれてしまい、fatal 処理（process.exit 等）が正常な
// プロトコルエラー応答を潰してしまう。
function wrapTransportStart(
  transport: Transport,
  onStartError?: (error: Error) => void,
): Transport {
  return {
    start: async () => {
      try {
        await transport.start();
      } catch (error) {
        onStartError?.(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    close: () => transport.close(),
    send: (message, sendOptions) => transport.send(message, sendOptions),
    get onclose() {
      return transport.onclose;
    },
    set onclose(handler) {
      transport.onclose = handler;
    },
    get onerror() {
      return transport.onerror;
    },
    set onerror(handler) {
      transport.onerror = handler;
    },
    get onmessage() {
      return transport.onmessage;
    },
    set onmessage(handler) {
      transport.onmessage = handler;
    },
  };
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
