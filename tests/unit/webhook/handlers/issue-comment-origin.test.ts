import { describe, expect, it, test, vi } from "vitest";
import type { Logger } from "../../../../src/config/logging.js";
import type { ReviewQueue } from "../../../../src/queue/review-queue.js";
import {
  evaluateCommentOrigin,
  handleIssueCommentEvent,
  type IssueCommentHandlerDeps,
} from "../../../../src/webhook/handlers/issue-comment.js";
import type { NormalizedEvent } from "../../../../src/webhook/normalize-event.js";

function makeQueue(): ReviewQueue {
  return {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    list: vi.fn(() => []),
    size: vi.fn(() => 0),
    onEnqueue: vi.fn(() => () => {}),
    onReReviewRequested: vi.fn(() => () => {}),
    listenerCounts: vi.fn(() => ({ onEnqueue: 0, onReReviewRequested: 0 })),
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeDeps(overrides: Partial<IssueCommentHandlerDeps> = {}): IssueCommentHandlerDeps {
  return {
    queue: makeQueue(),
    logger: makeLogger(),
    allowedRepos: ["org/repo"],
    allowedAuthors: ["alice", "mcp-gateway-authentication-app"],
    appSlug: "thread-owl",
    ...overrides,
  };
}

function makeEvent(issueUser: unknown, commentUser: unknown): NormalizedEvent {
  return {
    type: "issue_comment",
    deliveryId: "d-1",
    installationId: 42,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: {
      action: "created",
      issue: {
        number: 7,
        pull_request: { url: "https://github.com/org/repo/pull/7" },
        user: issueUser,
      },
      comment: { id: 999, body: "@thread-owl re-review requested", user: commentUser },
    },
  };
}

describe("evaluateCommentOrigin", () => {
  const ALLOWED = ["alice", "bot-app"];

  it.each([
    {
      name: "検証が無効なら許可（暫定）",
      allowed: [],
      commenter: null,
      author: null,
      expected: null,
    },
    {
      name: "投稿者も PR の作成者も許可",
      allowed: ALLOWED,
      commenter: "alice",
      author: "alice",
      expected: null,
    },
    {
      name: "bot 名義の投稿者（[bot] の有無を問わない）",
      allowed: ALLOWED,
      commenter: "bot-app[bot]",
      author: "alice",
      expected: null,
    },
    {
      name: "投稿者を取得できない",
      allowed: ALLOWED,
      commenter: null,
      author: "alice",
      expected: "commenter_unknown",
    },
    {
      name: "許可されていない投稿者",
      allowed: ALLOWED,
      commenter: "mallory",
      author: "alice",
      expected: "commenter_not_allowed",
    },
    {
      name: "PR の作成者を取得できない",
      allowed: ALLOWED,
      commenter: "alice",
      author: null,
      expected: "pr_author_unknown",
    },
    // 許可された投稿者が、他者の PR への再レビューを依頼して queue に載せることを防ぐ
    {
      name: "投稿者は許可されているが、PR の作成者が許可されていない",
      allowed: ALLOWED,
      commenter: "alice",
      author: "mallory",
      expected: "pr_author_not_allowed",
    },
  ])("$name", ({ allowed, commenter, author, expected }) => {
    expect(evaluateCommentOrigin(allowed, commenter, author)).toBe(expected);
  });
});

describe("issue_comment webhook の投稿者・PR の作成者の検証", () => {
  test("投稿者も PR の作成者も許可されていれば enqueue する", async () => {
    const deps = makeDeps();

    await handleIssueCommentEvent(
      makeEvent({ login: "alice" }, { login: "mcp-gateway-authentication-app[bot]" }),
      deps,
    );

    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "re-review-requested",
        requestedBy: "mcp-gateway-authentication-app[bot]",
      }),
    );
  });

  test.each([
    {
      name: "許可されていない投稿者",
      issueUser: { login: "alice" },
      commentUser: { login: "mallory" },
      reason: "commenter_not_allowed",
      commenterLogin: "mallory",
      prAuthorLogin: "alice",
    },
    {
      name: "許可されていない PR の作成者",
      issueUser: { login: "mallory" },
      commentUser: { login: "alice" },
      reason: "pr_author_not_allowed",
      commenterLogin: "alice",
      prAuthorLogin: "mallory",
    },
    {
      name: "投稿者が payload に無い",
      issueUser: { login: "alice" },
      commentUser: undefined,
      reason: "commenter_unknown",
      commenterLogin: null,
      prAuthorLogin: "alice",
    },
    {
      name: "PR の作成者が payload に無い",
      issueUser: undefined,
      commentUser: { login: "alice" },
      reason: "pr_author_unknown",
      commenterLogin: "alice",
      prAuthorLogin: null,
    },
  ])(
    "$name は enqueue せず、監査ログに残す",
    async ({ issueUser, commentUser, reason, commenterLogin, prAuthorLogin }) => {
      const deps = makeDeps();

      await handleIssueCommentEvent(makeEvent(issueUser, commentUser), deps);

      expect(deps.queue.enqueue).not.toHaveBeenCalled();
      expect(deps.logger.info).toHaveBeenCalledWith("webhook.issue_comment.origin.rejected", {
        event: "webhook.issue_comment.origin.rejected",
        owner: "org",
        repo: "repo",
        prNumber: 7,
        reason,
        commenterLogin,
        prAuthorLogin,
      });
    },
  );

  test("再レビューを示さないコメントは、検証の対象にせずログも出さない", async () => {
    const deps = makeDeps();
    const event = makeEvent({ login: "mallory" }, { login: "mallory" });
    (event.payload as { comment: { body: string } }).comment.body = "ordinary comment";

    await handleIssueCommentEvent(event, deps);

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      "webhook.issue_comment.origin.rejected",
      expect.anything(),
    );
  });

  test("検証が無効（allowlist が空）なら enqueue する（暫定の互換動作）", async () => {
    const deps = makeDeps({ allowedAuthors: [] });

    await handleIssueCommentEvent(makeEvent({ login: "mallory" }, { login: "mallory" }), deps);

    expect(deps.queue.enqueue).toHaveBeenCalled();
  });
});
