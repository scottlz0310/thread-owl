import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer, runTool } from "../../../src/mcp/server.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";

function makeDeps(): ToolDeps {
  return { getClient: vi.fn(), getWriteContext: vi.fn() };
}

describe("createMcpServer", () => {
  it("transport に依存しない McpServer インスタンスを返す", () => {
    const server = createMcpServer(makeDeps(), { name: "thread-owl", version: "0.1.0" });

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  it("5 つの review tool を登録する", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");

    createMcpServer(makeDeps(), { name: "thread-owl", version: "0.1.0" });

    const registeredNames = spy.mock.calls.map((call) => call[0]);
    expect(registeredNames).toEqual([
      "get_pr",
      "list_review_threads",
      "post_summary_comment",
      "post_inline_comment",
      "reply_review_thread",
    ]);

    spy.mockRestore();
  });
});

describe("runTool", () => {
  it("成功時は JSON を text content として返す", async () => {
    const result = await runTool(async () => ({ ok: true }));

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({
      type: "text",
      text: JSON.stringify({ ok: true }, null, 2),
    });
  });

  it("失敗時は isError と error.message を返す", async () => {
    const result = await runTool(async () => {
      throw new Error("boom");
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("boom");
  });
});
