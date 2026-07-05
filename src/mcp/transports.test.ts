import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../config/logging.js";
import { createMcpServer } from "./server.js";
import { startMcpHttpServer } from "./transports.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeServerFactory() {
  return () =>
    createMcpServer(
      {
        getClient: async (): Promise<never> => {
          throw new Error("not used");
        },
        getWriteContext: async (): Promise<never> => {
          throw new Error("not used");
        },
        allowedRepos: ["org/repo"],
        resolveInstallationId: async (): Promise<number> => 1,
      },
      { name: "test", version: "0.0.0" },
    );
}

describe("startMcpHttpServer - non-MCP path routing", () => {
  test("calls fallbackHandler for requests outside the MCP path", async () => {
    let fallbackCalled = false;
    const srv = await startMcpHttpServer(makeServerFactory(), {
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

  test("returns 404 for non-MCP paths when fallbackHandler is not set", async () => {
    const srv = await startMcpHttpServer(makeServerFactory(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    expect(res.status).toBe(404);

    await srv.close();
  });
});

describe("startMcpHttpServer - session count diagnostics (#117)", () => {
  test("logs session count on session init and close", async () => {
    const logger = makeLogger();
    const srv = await startMcpHttpServer(makeServerFactory(), {
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      logger,
    });

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${srv.port}/mcp`),
    );
    await client.connect(transport);

    expect(logger.info).toHaveBeenCalledWith(
      "mcp.session.initialized",
      expect.objectContaining({ sessionCount: 1 }),
    );

    await transport.terminateSession();
    await client.close();
    await new Promise((r) => setTimeout(r, 20));

    const closedCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) => event === "mcp.session.closed",
    );
    expect(closedCalls).toHaveLength(1);
    expect(closedCalls[0][1]).toMatchObject({ sessionCount: 0 });

    await srv.close();
  });
});
