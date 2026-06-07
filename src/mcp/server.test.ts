import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, test, vi } from "vitest";
import { createReviewQueue, type ReviewCandidate } from "../queue/review-queue.js";
import { createMcpServer, QUEUE_RESOURCE_URI } from "./server.js";

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

function makeMinimalDeps() {
  return {
    getClient: async (): Promise<never> => {
      throw new Error("not used in subscription tests");
    },
    getWriteContext: async (): Promise<never> => {
      throw new Error("not used in subscription tests");
    },
  };
}

async function setupServerAndClient(queue: ReturnType<typeof createReviewQueue>) {
  const server = createMcpServer(
    { ...makeMinimalDeps(), queue },
    { name: "test", version: "0.0.0" },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const notifications: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    notifications.push(n.params.uri);
  });
  await client.connect(clientTransport);

  return { server, client, notifications };
}

describe("createMcpServer — queue resource listing and reading", () => {
  test("listResources returns queue://review/queue", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    const result = await client.listResources();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].uri).toBe(QUEUE_RESOURCE_URI);

    await client.close();
    await server.close();
  });

  test("readResource returns current queue contents as JSON", async () => {
    const queue = createReviewQueue();
    const { server, client } = await setupServerAndClient(queue);

    queue.enqueue(makeCandidate(42));
    const result = await client.readResource({ uri: QUEUE_RESOURCE_URI });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
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
});

describe("createMcpServer — queue resource subscription", () => {
  test("subscribe → enqueue sends 1 notification", async () => {
    const queue = createReviewQueue();
    const { server, client, notifications } = await setupServerAndClient(queue);

    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI });
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 20));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toBe(QUEUE_RESOURCE_URI);

    await client.close();
    await server.close();
  });

  test("subscribe → unsubscribe → re-subscribe: enqueue sends exactly 1 notification", async () => {
    const queue = createReviewQueue();
    const { server, client, notifications } = await setupServerAndClient(queue);

    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI });
    await client.unsubscribeResource({ uri: QUEUE_RESOURCE_URI });
    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI });

    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 20));

    // listener が蓄積していると 2 回以上通知が来る（修正前の挙動）
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toBe(QUEUE_RESOURCE_URI);

    await client.close();
    await server.close();
  });

  test("unsubscribe stops notifications", async () => {
    const queue = createReviewQueue();
    const { server, client, notifications } = await setupServerAndClient(queue);

    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI });
    await client.unsubscribeResource({ uri: QUEUE_RESOURCE_URI });

    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 20));

    expect(notifications).toHaveLength(0);

    await client.close();
    await server.close();
  });

  test("duplicate subscribe is a no-op (second call does not register extra listener)", async () => {
    const queue = createReviewQueue();
    const { server, client, notifications } = await setupServerAndClient(queue);

    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI });
    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI }); // no-op

    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 20));

    expect(notifications).toHaveLength(1);

    await client.close();
    await server.close();
  });

  test("sendResourceUpdated failure after re-subscribe does not remove new listener", async () => {
    const queue = createReviewQueue();
    const mcpServer = createMcpServer(
      { ...makeMinimalDeps(), queue },
      { name: "test", version: "0.0.0" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const notifications: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      notifications.push(n.params.uri);
    });
    await client.connect(clientTransport);

    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI });

    // sendResourceUpdated を遅延 reject に差し替えて pending 状態を作る
    let rejectSend!: () => void;
    const deferred = new Promise<void>((_, reject) => {
      rejectSend = () => reject(new Error("transport closed"));
    });
    vi.spyOn(mcpServer.server, "sendResourceUpdated").mockReturnValueOnce(deferred);

    // Enqueue 1 — listener が起動し sendResourceUpdated が pending になる
    queue.enqueue(makeCandidate(1));

    // pending 中に unsubscribe → re-subscribe（新 listener 登録）
    await client.unsubscribeResource({ uri: QUEUE_RESOURCE_URI });
    await client.subscribeResource({ uri: QUEUE_RESOURCE_URI });

    // 旧 sendResourceUpdated を reject（catch が走る）
    rejectSend();
    await new Promise((r) => setTimeout(r, 20));

    vi.restoreAllMocks();

    // Enqueue 2 — 新 listener が解除されていなければ通知が届く
    queue.enqueue(makeCandidate(2));
    await new Promise((r) => setTimeout(r, 20));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toBe(QUEUE_RESOURCE_URI);

    await client.close();
    await mcpServer.close();
  });
});
