import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  McpServer,
  type ReadResourceResult,
} from "@modelcontextprotocol/server";
import { describe, expect, it, test, vi } from "vitest";
import {
  createMcpServer,
  QUEUE_RESOURCE_URI,
  RE_REVIEW_RESOURCE_URI,
  runTool,
} from "../../../src/mcp/server.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";
import { ENQUEUE_REVIEW_TOOL_NAME } from "../../../src/mcp/tools/enqueue-review.js";
import { createReviewQueue, type ReviewCandidate } from "../../../src/queue/review-queue.js";

function makeDeps(): ToolDeps {
  return {
    getClient: vi.fn(),
    getWriteContext: vi.fn(),
    allowedRepos: [],
    resolveInstallationId: vi.fn(),
  };
}

function makeCandidate(prNumber = 1): ReviewCandidate {
  return {
    owner: "org",
    repo: "repo",
    prNumber,
    installationId: 1,
    queuedAt: new Date(),
    reason: "opened",
  };
}

async function setupServerAndClient(queue: ReturnType<typeof createReviewQueue>) {
  const server = createMcpServer(
    { ...makeDeps(), allowedRepos: ["org/repo"], resolveInstallationId: async () => 1, queue },
    { name: "test", version: "0.0.0" },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return { server, client };
}

describe("createMcpServer", () => {
  it("transport に依存しない McpServer インスタンスを返す", () => {
    const server = createMcpServer(makeDeps(), { name: "thread-owl", version: "0.1.0" });

    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });

  it("6 つの review tool を登録する", () => {
    const spy = vi.spyOn(McpServer.prototype, "registerTool");

    createMcpServer(makeDeps(), { name: "thread-owl", version: "0.1.0" });

    const registeredNames = spy.mock.calls.map((call) => call[0]);
    expect(registeredNames).toEqual([
      "get_pr",
      "list_review_threads",
      "post_summary_comment",
      "post_inline_comment",
      "reply_review_thread",
      "approve_pull_request",
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

describe("createMcpServer — queue resource listing and reading", () => {
  test("listResources returns both queue resources", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri);
    expect(uris).toContain(QUEUE_RESOURCE_URI);
    expect(uris).toContain(RE_REVIEW_RESOURCE_URI);

    await client.close();
    await server.close();
  });

  test("readResource returns current queue contents as JSON", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    queue.enqueue(makeCandidate(42));
    const result = await client.readResource({ uri: QUEUE_RESOURCE_URI });

    expect(result.contents).toHaveLength(1);
    const content: ReadResourceResult["contents"][number] = result.contents[0];
    expect("text" in content).toBe(true);
    const parsed = JSON.parse((content as { text: string }).text) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed[0] as { prNumber: number }).prNumber).toBe(42);

    await client.close();
    await server.close();
  });

  test("readResource with unknown URI returns MCP error", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    await expect(client.readResource({ uri: "queue://unknown" })).rejects.toThrow();

    await client.close();
    await server.close();
  });

  test("readResource re-review-requests returns only re-review-requested entries", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    queue.enqueue(makeCandidate(1)); // opened
    queue.enqueue({ ...makeCandidate(2), reason: "re-review-requested" });

    const result = await client.readResource({ uri: RE_REVIEW_RESOURCE_URI });
    const parsed = JSON.parse((result.contents[0] as { text: string }).text) as {
      prNumber: number;
    }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].prNumber).toBe(2);

    await client.close();
    await server.close();
  });
});

describe("createMcpServer — enqueue_review tool", () => {
  test("tools/list includes enqueue_review when a queue is configured", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    const result = await client.listTools();
    expect(result.tools.map((t) => t.name)).toContain(ENQUEUE_REVIEW_TOOL_NAME);

    await client.close();
    await server.close();
  });

  test("valid call enqueues candidate", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    const result = await client.callTool({
      name: ENQUEUE_REVIEW_TOOL_NAME,
      arguments: { owner: "org", repo: "repo", prNumber: 7, reason: "opened" },
    });

    expect(result.isError).toBeFalsy();
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({ owner: "org", repo: "repo", prNumber: 7 });

    await client.close();
    await server.close();
  });

  test("re-review-requested call records requestedBy", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    await client.callTool({
      name: ENQUEUE_REVIEW_TOOL_NAME,
      arguments: {
        owner: "org",
        repo: "repo",
        prNumber: 7,
        reason: "re-review-requested",
        requestedBy: "alice",
      },
    });

    expect(queue.list()[0].requestedBy).toBe("alice");

    await client.close();
    await server.close();
  });

  test("rejects repo outside allowlist without enqueueing", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    const result = await client.callTool({
      name: ENQUEUE_REVIEW_TOOL_NAME,
      arguments: { owner: "other", repo: "repo", prNumber: 1, reason: "opened" },
    });

    expect(result.isError).toBe(true);
    expect(queue.size()).toBe(0);

    await client.close();
    await server.close();
  });

  test("rejects invalid reason", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    const result = await client.callTool({
      name: ENQUEUE_REVIEW_TOOL_NAME,
      arguments: { owner: "org", repo: "repo", prNumber: 1, reason: "invalid" },
    });

    expect(result.isError).toBe(true);
    expect(queue.size()).toBe(0);

    await client.close();
    await server.close();
  });

  test("rejects missing required arguments", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    const result = await client.callTool({
      name: ENQUEUE_REVIEW_TOOL_NAME,
      arguments: { owner: "org", repo: "repo" },
    });

    expect(result.isError).toBe(true);
    expect(queue.size()).toBe(0);

    await client.close();
    await server.close();
  });
});
