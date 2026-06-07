import { describe, expect, test } from "vitest";
import { createMcpServer } from "./server.js";
import { startMcpHttpServer } from "./transports.js";

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
