import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../../src/config/logging.js";
import type { ReviewQueue } from "../../../../src/queue/review-queue.js";
import {
  detectReReviewMention,
  handleIssueCommentEvent,
  type IssueCommentHandlerDeps,
} from "../../../../src/webhook/handlers/issue-comment.js";
import type { NormalizedEvent } from "../../../../src/webhook/normalize-event.js";

const APP_SLUG = "thread-owl";

// ─── detectReReviewMention ───────────────────────────────────────────────────

describe("detectReReviewMention", () => {
  it.each([
    // 推奨形式
    { body: "@thread-owl re-review requested\n\nPlease review again.", expected: true },
    // 最小形式
    { body: "@thread-owl re-review", expected: true },
    // rereview バリアント
    { body: "@thread-owl rereview", expected: true },
    // review again バリアント
    { body: "@thread-owl review again", expected: true },
    // 日本語
    { body: "@thread-owl 再レビューをお願いします", expected: true },
    // 大文字 appSlug
    { body: "@Thread-Owl re-review requested", expected: true },
    // mention なし
    { body: "re-review requested", expected: false },
    // intent なし（通常コメント）
    { body: "@thread-owl LGTM!", expected: false },
    // 別アプリへの mention
    { body: "@copilot re-review", expected: false },
    // 空文字
    { body: "", expected: false },
  ])("$body → $expected", ({ body, expected }) => {
    expect(detectReReviewMention(body, APP_SLUG)).toBe(expected);
  });
});

// ─── handleIssueCommentEvent ─────────────────────────────────────────────────

function makeQueue(): ReviewQueue {
  return {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    list: vi.fn(() => []),
    size: vi.fn(() => 0),
    onEnqueue: vi.fn(() => () => {}),
    onReReviewRequested: vi.fn(() => () => {}),
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeEvent(payloadOverrides: Record<string, unknown> = {}): NormalizedEvent {
  return {
    type: "issue_comment",
    deliveryId: "delivery-abc",
    installationId: 42,
    owner: "org",
    repo: "my-repo",
    prNumber: 7,
    payload: {
      action: "created",
      issue: {
        number: 7,
        pull_request: { url: "https://github.com/org/my-repo/pull/7" },
      },
      comment: {
        id: 999,
        body: "@thread-owl re-review requested\n\nThe changes have been addressed.",
        user: { login: "human-user" },
      },
      ...payloadOverrides,
    },
  };
}

function makeDeps(overrides: Partial<IssueCommentHandlerDeps> = {}): IssueCommentHandlerDeps {
  return {
    queue: makeQueue(),
    logger: makeLogger(),
    allowedRepos: ["org/my-repo"],
    appSlug: APP_SLUG,
    ...overrides,
  };
}

describe("handleIssueCommentEvent", () => {
  it("@thread-owl re-review mention を検出して enqueue する", async () => {
    const deps = makeDeps();
    await handleIssueCommentEvent(makeEvent(), deps);

    expect(deps.queue.enqueue).toHaveBeenCalledOnce();
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "my-repo",
        prNumber: 7,
        installationId: 42,
        reason: "re-review-requested",
        sourceCommentId: 999,
        requestedBy: "human-user",
      }),
    );
  });

  it("re-review intent のない通常コメントは enqueue しない", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      comment: { id: 1, body: "@thread-owl LGTM!", user: { login: "human-user" } },
    });
    await handleIssueCommentEvent(event, deps);

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it("@thread-owl mention のないコメントは enqueue しない", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      comment: { id: 2, body: "re-review please", user: { login: "human-user" } },
    });
    await handleIssueCommentEvent(event, deps);

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it("PR に紐づかない issue comment は enqueue しない", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      issue: { number: 7 }, // pull_request フィールドなし
    });
    await handleIssueCommentEvent(event, deps);

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it("allowlist 外リポジトリは enqueue しない", async () => {
    const deps = makeDeps({ allowedRepos: [] });
    await handleIssueCommentEvent(makeEvent(), deps);

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it("action が created 以外は enqueue しない", async () => {
    const deps = makeDeps();
    const event = makeEvent({ action: "edited" });
    await handleIssueCommentEvent(event, deps);

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  it.each([["re-review"], ["rereview"], ["review again"], ["再レビュー"]])(
    "intent キーワード '%s' を含む mention は enqueue する",
    async (keyword) => {
      const deps = makeDeps();
      const event = makeEvent({
        comment: {
          id: 1,
          body: `@thread-owl ${keyword}`,
          user: { login: "someone" },
        },
      });
      await handleIssueCommentEvent(event, deps);

      expect(deps.queue.enqueue).toHaveBeenCalledOnce();
      expect(deps.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "re-review-requested" }),
      );
    },
  );

  it("comment.user が欠落しても requestedBy を undefined で enqueue する", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      comment: { id: 5, body: "@thread-owl re-review" },
    });
    await handleIssueCommentEvent(event, deps);

    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: undefined }),
    );
  });

  it("comment.id が数値でない場合 sourceCommentId を undefined で enqueue する", async () => {
    const deps = makeDeps();
    const event = makeEvent({
      comment: { id: "not-a-number", body: "@thread-owl re-review", user: { login: "human" } },
    });
    await handleIssueCommentEvent(event, deps);

    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sourceCommentId: undefined }),
    );
  });
});
