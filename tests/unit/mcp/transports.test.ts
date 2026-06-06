import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../../src/mcp/server.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";
import {
  type StartedMcpHttpServer,
  startMcpHttpServer,
  startMcpStdioServer,
} from "../../../src/mcp/transports.js";

function makeDeps(): ToolDeps {
  return { getClient: vi.fn(), getWriteContext: vi.fn() };
}

function makeServer() {
  return createMcpServer(makeDeps(), { name: "thread-owl", version: "0.1.0" });
}

describe("startMcpStdioServer", () => {
  it("StdioServerTransport に接続して従来の stdio 経路を起動する", async () => {
    const server = makeServer();
    const transport = new StdioServerTransport(new PassThrough(), new PassThrough());

    await startMcpStdioServer(server, transport);

    expect(server.isConnected()).toBe(true);
    await server.close();
  });
});

describe("startMcpHttpServer", () => {
  let startedServer: StartedMcpHttpServer | undefined;

  afterEach(async () => {
    await startedServer?.close();
    startedServer = undefined;
  });

  it("Streamable HTTP client から tools/list を呼び出せる", async () => {
    const createServer = vi.fn(makeServer);
    startedServer = await startMcpHttpServer(createServer, {
      host: "127.0.0.1",
      port: 0,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${startedServer.port}/mcp`),
    );

    await client.connect(transport);
    const result = await client.listTools();

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "get_pr",
      "list_review_threads",
      "post_summary_comment",
      "post_inline_comment",
      "reply_review_thread",
    ]);
    expect(transport.sessionId).toBeDefined();
    expect(createServer).toHaveBeenCalledTimes(1);

    await transport.terminateSession();
    await client.close();
  });

  it("client session ごとに McpServer と transport を生成する", async () => {
    const createServer = vi.fn(makeServer);
    startedServer = await startMcpHttpServer(createServer, {
      host: "127.0.0.1",
      port: 0,
    });
    const endpoint = new URL(`http://127.0.0.1:${startedServer.port}/mcp`);
    const clients = [
      {
        client: new Client({ name: "client-1", version: "1.0.0" }),
        transport: new StreamableHTTPClientTransport(endpoint),
      },
      {
        client: new Client({ name: "client-2", version: "1.0.0" }),
        transport: new StreamableHTTPClientTransport(endpoint),
      },
    ];

    for (const { client, transport } of clients) {
      await client.connect(transport);
    }

    expect(createServer).toHaveBeenCalledTimes(2);
    expect(clients[0].transport.sessionId).toBeDefined();
    expect(clients[1].transport.sessionId).toBeDefined();
    expect(clients[0].transport.sessionId).not.toBe(clients[1].transport.sessionId);

    for (const { client, transport } of clients) {
      await transport.terminateSession();
      await client.close();
    }
  });

  it("session close 後は同じ session ID を 404 で拒否する", async () => {
    startedServer = await startMcpHttpServer(makeServer, {
      host: "127.0.0.1",
      port: 0,
    });
    const endpoint = `http://127.0.0.1:${startedServer.port}/mcp`;
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    await client.connect(transport);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();

    await transport.terminateSession();

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-session-id": sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    expect(response.status).toBe(404);
    await client.close();
  });

  it("session ID なしの非 initialize request を 400 で拒否する", async () => {
    const createServer = vi.fn(makeServer);
    startedServer = await startMcpHttpServer(createServer, {
      host: "127.0.0.1",
      port: 0,
    });

    const response = await fetch(`http://127.0.0.1:${startedServer.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("session 初期化の異常終了を記録して 500 を返す", async () => {
    const onError = vi.fn();
    startedServer = await startMcpHttpServer(
      () => {
        throw new Error("initialization failed");
      },
      {
        host: "127.0.0.1",
        port: 0,
        onError,
      },
    );

    const response = await fetch(`http://127.0.0.1:${startedServer.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "initialization failed" }),
    );
  });

  it("HTTP server shutdown 時に active session をすべて close する", async () => {
    const servers = [makeServer(), makeServer()];
    const closeSpies = servers.map((server) => vi.spyOn(server, "close"));
    startedServer = await startMcpHttpServer(
      () => {
        const server = servers.shift();
        if (!server) {
          throw new Error("unexpected server creation");
        }
        return server;
      },
      {
        host: "127.0.0.1",
        port: 0,
      },
    );
    const endpoint = new URL(`http://127.0.0.1:${startedServer.port}/mcp`);
    const clients = [
      {
        client: new Client({ name: "client-1", version: "1.0.0" }),
        transport: new StreamableHTTPClientTransport(endpoint),
      },
      {
        client: new Client({ name: "client-2", version: "1.0.0" }),
        transport: new StreamableHTTPClientTransport(endpoint),
      },
    ];
    for (const { client, transport } of clients) {
      await client.connect(transport);
    }

    await startedServer.close();
    startedServer = undefined;

    expect(closeSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    for (const { client } of clients) {
      await client.close();
    }
  });

  it("session close の失敗を cleanup 後に呼び出し元へ伝播する", async () => {
    const server = makeServer();
    vi.spyOn(server, "close").mockRejectedValue(new Error("close failed"));
    startedServer = await startMcpHttpServer(() => server, {
      host: "127.0.0.1",
      port: 0,
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${startedServer.port}/mcp`),
    );
    await client.connect(transport);

    await expect(startedServer.close()).rejects.toThrow("Failed to close MCP HTTP server");
    startedServer = undefined;
    await client.close();
  });
});
