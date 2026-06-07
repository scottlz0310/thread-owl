import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";
import { type ReviewCandidate, createReviewQueue } from "../queue/review-queue.js";
import { QUEUE_RESOURCE_URI, createMcpServer } from "./server.js";

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
});
