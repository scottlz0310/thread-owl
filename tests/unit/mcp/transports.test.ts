import { PassThrough } from "node:stream";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer, QUEUE_RESOURCE_URI } from "../../../src/mcp/server.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";
import {
  type StartedMcpHttpServer,
  startMcpHttpServer,
  startMcpStdioServer,
} from "../../../src/mcp/transports.js";
import { createReviewQueue } from "../../../src/queue/review-queue.js";

function makeDeps(): ToolDeps {
  return {
    getClient: vi.fn(),
    getWriteContext: vi.fn(),
    allowedRepos: ["org/repo"],
    resolveInstallationId: vi.fn(async () => 1),
  };
}

function makeServer() {
  return createMcpServer(makeDeps(), { name: "thread-owl", version: "0.1.0" });
}

async function connectModernClient(port: number, path = "/mcp") {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`));
  await client.connect(transport);
  return { client, transport };
}

describe("startMcpHttpServer", () => {
  let startedServer: StartedMcpHttpServer | undefined;

  afterEach(async () => {
    await startedServer?.close();
    startedServer = undefined;
  });

  it.each([
    { name: "default path", configuredPath: undefined, requestPath: "/mcp" },
    { name: "default path with slash", configuredPath: undefined, requestPath: "/mcp/" },
    { name: "custom path", configuredPath: "/custom/mcp", requestPath: "/custom/mcp" },
    {
      name: "custom path with request slash",
      configuredPath: "/custom/mcp",
      requestPath: "/custom/mcp/",
    },
    {
      name: "custom path with configured slash",
      configuredPath: "/custom/mcp/",
      requestPath: "/custom/mcp",
    },
  ])("$name は末尾スラッシュの有無を同一視する", async ({ configuredPath, requestPath }) => {
    startedServer = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
      path: configuredPath,
    });

    const { client } = await connectModernClient(startedServer.port, requestPath);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toContain("get_pr");
    await client.close();
  });

  it("Streamable HTTP client から tools/list を呼び出せる", async () => {
    const createServer = vi.fn(makeServer);
    startedServer = await startMcpHttpServer(createServer, {
      host: "127.0.0.1",
      port: 0,
    });

    const { client } = await connectModernClient(startedServer.port);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "get_pr",
      "list_review_threads",
      "post_summary_comment",
      "post_inline_comment",
      "reply_review_thread",
      "approve_pull_request",
    ]);

    await client.close();
  });

  it("bind 失敗を呼び出し元へ伝播する", async () => {
    startedServer = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
    });

    await expect(
      startMcpHttpServer(makeServer, {
        host: "127.0.0.1",
        port: startedServer.port,
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });

  it("close() は handler.close() を呼んで in-flight exchange を畳む", async () => {
    startedServer = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
    });
    const { client } = await connectModernClient(startedServer.port);
    await client.listTools();

    await startedServer.close();
    const closedServer = startedServer;
    startedServer = undefined;

    // close 後は同じ port へ再度 bind できる（HTTP server が確実に閉じている）
    const reopened = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: closedServer.port,
    });
    startedServer = reopened;

    await client.close();
  });
});

describe("startMcpHttpServer - non-MCP path routing", () => {
  it("calls fallbackHandler for requests outside the MCP path", async () => {
    let fallbackCalled = false;
    const srv = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      fallbackHandler: async (_req, res) => {
        fallbackCalled = true;
        res.writeHead(200).end("ok");
      },
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    expect(fallbackCalled).toBe(true);
    expect(res.status).toBe(200);

    await srv.close();
  });

  it("returns 404 for non-MCP paths when fallbackHandler is not set", async () => {
    const srv = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    expect(res.status).toBe(404);

    await srv.close();
  });
});

describe("startMcpHttpServer - legacy (2025-11-25) rejection (#176)", () => {
  it("GET は 405 を返し Mcp-Session-Id を mint しない", async () => {
    const srv = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("mcp-session-id")).toBeNull();

    await srv.close();
  });

  it("DELETE は 405 を返し Mcp-Session-Id を mint しない", async () => {
    const srv = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("mcp-session-id")).toBeNull();

    await srv.close();
  });

  it("2025-era の initialize は unsupported-protocol-version エラーで拒否される", async () => {
    const srv = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "0.0.0" },
        },
      }),
    });
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32022);

    await srv.close();
  });

  it("応答に X-Accel-Buffering: no を付与する（リバースプロキシのバッファリング抑止）", async () => {
    const srv = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, { method: "GET" });
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    await srv.close();
  });
});

describe("startMcpHttpServer - subscriptions/listen contract (#176)", () => {
  it("listen → ack → resources/updated → resources/read", async () => {
    const queue = createReviewQueue();
    const srv = await startMcpHttpServer(
      () => createMcpServer({ ...makeDeps(), queue }, { name: "test", version: "0.0.0" }),
      { host: "127.0.0.1", port: 0, path: "/mcp" },
    );
    queue.onEnqueue(() => srv.notify.resourceUpdated(QUEUE_RESOURCE_URI));

    const { client } = await connectModernClient(srv.port);
    const notifications: string[] = [];
    client.setNotificationHandler("notifications/resources/updated", (n) => {
      notifications.push(n.params.uri);
    });

    const subscription = await client.listen({ resourceSubscriptions: [QUEUE_RESOURCE_URI] });
    expect(subscription.honoredFilter.resourceSubscriptions).toContain(QUEUE_RESOURCE_URI);

    queue.enqueue({
      owner: "org",
      repo: "repo",
      prNumber: 1,
      installationId: 1,
      queuedAt: new Date(),
      reason: "opened",
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(notifications).toContain(QUEUE_RESOURCE_URI);

    const result = await client.readResource({ uri: QUEUE_RESOURCE_URI });
    const parsed = JSON.parse((result.contents[0] as { text: string }).text) as unknown[];
    expect(parsed).toHaveLength(1);

    await subscription.close();
    await client.close();
    await srv.close();
  });
});

describe("startMcpStdioServer", () => {
  it("stdio 経路で server/discover に応答する（2026-07-28 のみを受け付ける）", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    const handle = startMcpStdioServer(makeServer, { transport });

    const responseBody = new Promise<string>((resolve) => {
      stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      })}\n`,
    );

    const response = JSON.parse(await responseBody) as {
      id: number;
      result?: { supportedVersions?: string[] };
      error?: unknown;
    };
    expect(response.id).toBe(1);
    expect(response.error).toBeUndefined();
    expect(response.result?.supportedVersions).toContain("2026-07-28");

    await handle.close();
  });

  it("transport.start() が reject した場合、onStartError で起動失敗を報告する", async () => {
    const startError = new Error("boom: failed to open stdio");
    const failingTransport: Transport = {
      start: async () => {
        throw startError;
      },
      close: async () => {},
      send: async () => {},
    };
    const onStartError = vi.fn();

    startMcpStdioServer(makeServer, { transport: failingTransport, onStartError });

    await vi.waitFor(() => {
      expect(onStartError).toHaveBeenCalledWith(startError);
    });
  });

  it("legacy 拒否応答は onError が呼ばれても最後まで届く（起動失敗と混同しない）", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new StdioServerTransport(stdin, stdout);
    const onError = vi.fn();
    const onStartError = vi.fn();
    const handle = startMcpStdioServer(makeServer, { transport, onError, onStartError });

    const responseBody = new Promise<string>((resolve) => {
      stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
    });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "0.0.0" },
        },
      })}\n`,
    );

    const response = JSON.parse(await responseBody) as { id: number; error?: { code: number } };
    expect(response.id).toBe(1);
    expect(response.error?.code).toBe(-32022);
    // onError（reporting only）は呼ばれるが、onStartError（fatal 判定用）は呼ばれない。
    expect(onError).toHaveBeenCalled();
    expect(onStartError).not.toHaveBeenCalled();

    await handle.close();
  });
});
