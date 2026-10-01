import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../config/logging.js";
import type { DeliveryDedup } from "../queue/delivery-dedup.js";
import { createDeliveryDedup } from "../queue/delivery-dedup.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import { createWebhookReceiver } from "./receiver.js";

const SECRET = "test-secret";

// 検証が無効（allowedAuthors が空）なら呼ばれない。呼ばれたらテストを失敗させる。
const unexpectedGetPullRequest = vi
  .fn()
  .mockRejectedValue(new Error("getPullRequest must not be called"));

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function makeDedup(seen = false): DeliveryDedup {
  return {
    isSeen: vi.fn().mockReturnValue(seen),
    markSeen: vi.fn(),
    forget: vi.fn(),
    dispose: vi.fn(),
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
    onEnqueue: vi.fn().mockReturnValue(() => undefined),
    onReReviewRequested: vi.fn().mockReturnValue(() => undefined),
    listenerCounts: vi.fn().mockReturnValue({ onEnqueue: 0, onReReviewRequested: 0 }),
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
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
    });
    const res = await app.request(makeRequest(makePrBody(), "pull_request", "d-1", "sha256=bad"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid signature" });
  });

  test("duplicate delivery → 200 duplicate", async () => {
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "test-app",
      dedup: makeDedup(true),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
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
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
    });
    const res = await app.request(makeRequest(body, "push"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ignored" });
  });

  test("invalid JSON (signed) → 400", async () => {
    const body = "not-json";
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
    });
    const res = await app.request(makeRequest(body, "pull_request"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid JSON" });
  });

  test("自 App sender → 200 skipped", async () => {
    const body = JSON.stringify({
      ...BASE_REPO,
      action: "opened",
      sender: { type: "Bot", login: "test-app[bot]" },
      pull_request: { number: 1, draft: false },
    });
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
    });
    const res = await app.request(makeRequest(body, "pull_request"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "skipped" });
  });

  test("第三者 bot sender は skipped にならず処理を続ける", async () => {
    const body = JSON.stringify({
      ...BASE_REPO,
      action: "opened",
      sender: { type: "Bot", login: "renovate[bot]" },
      pull_request: { number: 1, draft: false },
    });
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
    });
    const res = await app.request(makeRequest(body, "pull_request"));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ status: "skipped" });
  });

  test("malformed payload (normalize fails) → 400", async () => {
    const body = JSON.stringify({ action: "opened" }); // missing installation/repository
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
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
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
    });
    const res = await app.request(makeRequest(b, eventType));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok" });
  });

  test("missing headers are treated as empty string (invalid signature)", async () => {
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
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
      appSlug: "test-app",
      dedup: makeDedup(),
      queue: makeQueue(),
      logger,
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
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
    const dedup = makeDedup();
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "test-app",
      dedup,
      queue: makeQueue(),
      logger,
      allowedRepos: ["org/repo"],
      allowedAuthors: [],
      getPullRequest: unexpectedGetPullRequest,
    });
    const res = await app.request(makeRequest(body, "pull_request_review_comment"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "handler failed" });
    // 再配信（同じ delivery ID）を再処理できるように、既読を取り消す
    expect(dedup.forget).toHaveBeenCalledWith("d-1");
    expect(logger.error).toHaveBeenCalledWith(
      "webhook.handler.error",
      expect.objectContaining({ errorMessage: "handler boom" }),
    );

    vi.restoreAllMocks();
    void handlePullRequestReviewCommentEvent; // suppress unused warning
  });

  // issue_comment の再レビュー依頼は、検証のために PR を取得する。取得の失敗は一時的なので、
  // GitHub の再配信（同じ delivery ID）が重複扱いにならず、再処理されて復旧できること。
  test("PR の取得に失敗した delivery は、同じ delivery ID の再配信で再処理される", async () => {
    const body = JSON.stringify({
      ...BASE_REPO,
      action: "created",
      sender: { type: "User", login: "alice" },
      issue: { number: 7, pull_request: { url: "https://api.github.com/repos/org/repo/pulls/7" } },
      comment: { id: 1, body: "@thread-owl re-review requested", user: { login: "alice" } },
    });
    const dedup = createDeliveryDedup();
    const queue = makeQueue();
    const getPullRequest = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitHub API pulls.get failed (status 502)"))
      .mockResolvedValueOnce({
        number: 7,
        title: "t",
        body: null,
        state: "open",
        draft: false,
        author: { login: "alice", type: "User" },
        head: { sha: "h", ref: "f", repo: { fullName: "org/repo", fork: false } },
        base: { sha: "b", ref: "main" },
        htmlUrl: "https://github.com/org/repo/pull/7",
      });
    const app = createWebhookReceiver({
      secret: SECRET,
      appSlug: "thread-owl",
      dedup,
      queue,
      logger: makeLogger(),
      allowedRepos: ["org/repo"],
      allowedAuthors: ["alice"],
      getPullRequest,
    });

    const first = await app.request(makeRequest(body, "issue_comment", "d-redeliver"));
    expect(first.status).toBe(500);
    expect(queue.enqueue).not.toHaveBeenCalled();

    const redelivered = await app.request(makeRequest(body, "issue_comment", "d-redeliver"));
    expect(redelivered.status).toBe(200);
    expect(await redelivered.json()).toMatchObject({ status: "ok" });
    expect(queue.enqueue).toHaveBeenCalledOnce();

    // 処理に成功した delivery は、以後は重複として扱う
    const again = await app.request(makeRequest(body, "issue_comment", "d-redeliver"));
    expect(await again.json()).toMatchObject({ status: "duplicate" });
    dedup.dispose();
  });
});
