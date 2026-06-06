import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../config/logging.js";
import type { DeliveryDedup } from "../queue/delivery-dedup.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import { createWebhookReceiver } from "./receiver.js";

const SECRET = "test-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function makeDedup(seen = false): DeliveryDedup {
  return {
    isSeen: vi.fn().mockReturnValue(seen),
    markSeen: vi.fn(),
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeQueue(): ReviewQueue {
  return {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    size: vi.fn().mockReturnValue(0),
  };
}

const BASE_REPO = {
  installation: { id: 1 },
  repository: { name: "repo", owner: { login: "org" } },
};

function makeRequest(
  body: string,
  eventType: string,
  deliveryId = "d-1",
  signature = sign(body),
): Request {
  return new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

function makePrBody(action = "opened"): string {
  return JSON.stringify({
    ...BASE_REPO,
    action,
    sender: { type: "User", login: "alice" },
    pull_request: { number: 1, draft: false },
  });
}

describe("createWebhookReceiver POST /webhook", () => {
  test("invalid signature → 401", async () => {
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    const res = await app.request(makeRequest(makePrBody(), "pull_request", "d-1", "sha256=bad"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid signature" });
  });

  test("duplicate delivery → 200 duplicate", async () => {
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(true),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    const body = makePrBody();
    const res = await app.request(makeRequest(body, "pull_request"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "duplicate" });
  });

  test("unsupported event type → 200 ignored", async () => {
    const body = JSON.stringify({ ...BASE_REPO, sender: { type: "User" } });
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    const res = await app.request(makeRequest(body, "push"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored" });
  });

  test("invalid JSON (signed) → 400", async () => {
    const body = "not-json";
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    const res = await app.request(makeRequest(body, "pull_request"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid JSON" });
  });

  test("bot sender → 200 skipped", async () => {
    const body = JSON.stringify({
      ...BASE_REPO,
      action: "opened",
      sender: { type: "Bot", login: "some-bot" },
      pull_request: { number: 1, draft: false },
    });
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    const res = await app.request(makeRequest(body, "pull_request"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "skipped" });
  });

  test("malformed payload (normalize fails) → 400", async () => {
    const body = JSON.stringify({ action: "opened" }); // missing installation/repository
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    const res = await app.request(makeRequest(body, "pull_request"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "payload normalization failed" });
  });

  test.each([
    { eventType: "pull_request", body: () => makePrBody() },
    {
      eventType: "issue_comment",
      body: () =>
        JSON.stringify({
          ...BASE_REPO,
          action: "created",
          sender: { type: "User" },
          issue: { number: 1 },
        }),
    },
    {
      eventType: "pull_request_review",
      body: () =>
        JSON.stringify({
          ...BASE_REPO,
          action: "submitted",
          sender: { type: "User" },
          pull_request: { number: 1 },
        }),
    },
    {
      eventType: "pull_request_review_comment",
      body: () =>
        JSON.stringify({
          ...BASE_REPO,
          action: "created",
          sender: { type: "User" },
          pull_request: { number: 1 },
        }),
    },
  ])("valid $eventType event → 200 ok", async ({ eventType, body }) => {
    const b = body();
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    const res = await app.request(makeRequest(b, eventType));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("missing headers are treated as empty string (invalid signature)", async () => {
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
    });
    // ヘッダーを一切付けないリクエスト → signature="" で検証失敗
    const res = await app.request(
      new Request("http://localhost/webhook", { method: "POST", body: makePrBody() }),
    );
    expect(res.status).toBe(401);
  });

  test("handler throws non-Error → 500 with string errorMessage", async () => {
    vi.spyOn(
      await import("./handlers/pull-request-review-comment.js"),
      "handlePullRequestReviewCommentEvent",
    ).mockRejectedValueOnce("string-error");

    const body = JSON.stringify({
      ...BASE_REPO,
      action: "created",
      sender: { type: "User" },
      pull_request: { number: 1 },
    });
    const logger = makeLogger();
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger,
    });
    const res = await app.request(makeRequest(body, "pull_request_review_comment"));
    expect(res.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      "webhook.handler.error",
      expect.objectContaining({ errorName: "UnknownError", errorMessage: "string-error" }),
    );
    vi.restoreAllMocks();
  });

  test("handler throws → 500", async () => {
    // pull_request_review_comment ハンドラを throw させるためにモック
    const { handlePullRequestReviewCommentEvent } = await import(
      "./handlers/pull-request-review-comment.js"
    );
    vi.spyOn(
      await import("./handlers/pull-request-review-comment.js"),
      "handlePullRequestReviewCommentEvent",
    ).mockRejectedValueOnce(new Error("handler boom"));

    const body = JSON.stringify({
      ...BASE_REPO,
      action: "created",
      sender: { type: "User" },
      pull_request: { number: 1 },
    });
    const logger = makeLogger();
    const app = createWebhookReceiver({
      secret: SECRET,
      dedup: makeDedup(),
      queue: makeQueue(),
      logger,
    });
    const res = await app.request(makeRequest(body, "pull_request_review_comment"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "handler failed" });
    expect(logger.error).toHaveBeenCalledWith(
      "webhook.handler.error",
      expect.objectContaining({ errorMessage: "handler boom" }),
    );

    vi.restoreAllMocks();
    void handlePullRequestReviewCommentEvent; // suppress unused warning
  });
});
