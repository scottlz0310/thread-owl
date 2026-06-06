import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../../src/mcp/server.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";

describe("createMcpServer", () => {
  it("McpServer インスタンスを返す（stdio transport に connect 可能）", () => {
    const deps: ToolDeps = { getClient: vi.fn(), getWriteContext: vi.fn() };

    const server = createMcpServer(deps, { name: "thread-owl", version: "0.1.0" });

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });
});
