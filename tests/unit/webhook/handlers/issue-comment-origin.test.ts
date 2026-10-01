import { describe, expect, it, test, vi } from "vitest";
import type { Logger } from "../../../../src/config/logging.js";
import type { PullRequest } from "../../../../src/github/pull-requests.js";
import type { ReviewQueue } from "../../../../src/queue/review-queue.js";
import {
  evaluateCommenter,
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

interface PrData {
  author: string | null;
  // head の repository。null は削除された fork など、取得できない場合。
  headRepo: { fullName: string; fork: boolean } | null;
}

const SAME_REPO = { fullName: "org/repo", fork: false };

function makePr({ author, headRepo }: PrData): PullRequest {
  return {
    number: 7,
    title: "t",
    body: null,
    state: "open",
    draft: false,
    author: author === null ? null : { login: author, type: "User" },
    head: { sha: "headsha", ref: "feature", repo: headRepo },
    base: { sha: "basesha", ref: "main" },
    htmlUrl: "https://github.com/org/repo/pull/7",
  };
}

function makeDeps(
  pr: PrData | Error,
  overrides: Partial<IssueCommentHandlerDeps> = {},
): IssueCommentHandlerDeps & { getPullRequest: ReturnType<typeof vi.fn> } {
  const getPullRequest = vi.fn(async () => {
    if (pr instanceof Error) throw pr;
    return makePr(pr);
  });
  return {
    queue: makeQueue(),
    logger: makeLogger(),
    allowedRepos: ["org/repo"],
    allowedAuthors: ["alice", "mcp-gateway-authentication-app"],
    getPullRequest,
    appSlug: "thread-owl",
    ...overrides,
  };
}

function makeEvent(commentUser: unknown): NormalizedEvent {
  return {
    type: "issue_comment",
    deliveryId: "d-1",
    installationId: 42,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: {
      action: "created",
      issue: { number: 7, pull_request: { url: "https://github.com/org/repo/pull/7" } },
      comment: { id: 999, body: "@thread-owl re-review requested", user: commentUser },
    },
  };
}

describe("evaluateCommenter", () => {
  const ALLOWED = ["alice", "bot-app"];

  it.each([
    {
      name: "allowlist が空（未設定）なら、すべて拒否（fail-closed）",
      allowed: [],
      commenter: "alice",
      expected: "author_allowlist_empty",
    },
    { name: "許可された投稿者", allowed: ALLOWED, commenter: "alice", expected: null },
    {
      name: "bot 名義の投稿者（[bot] の有無を問わない）",
      allowed: ALLOWED,
      commenter: "bot-app[bot]",
      expected: null,
    },
    {
      name: "投稿者を取得できない",
      allowed: ALLOWED,
      commenter: null,
      expected: "commenter_unknown",
    },
    {
      name: "許可されていない投稿者",
      allowed: ALLOWED,
      commenter: "mallory",
      expected: "commenter_not_allowed",
    },
  ])("$name", ({ allowed, commenter, expected }) => {
    expect(evaluateCommenter(allowed, commenter)).toBe(expected);
  });
});

describe("issue_comment webhook の投稿者・PR の作成者・fork の検証", () => {
  test("投稿者・PR の作成者が許可され、同一リポジトリの PR なら enqueue する", async () => {
    const deps = makeDeps({ author: "alice", headRepo: SAME_REPO });

    await handleIssueCommentEvent(
      makeEvent({ login: "mcp-gateway-authentication-app[bot]" }),
      deps,
    );

    expect(deps.getPullRequest).toHaveBeenCalledWith("org", "repo", 7);
    expect(deps.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "re-review-requested",
        requestedBy: "mcp-gateway-authentication-app[bot]",
      }),
    );
  });

  // 許可された投稿者が、他者の PR や fork の PR への再レビューを依頼して queue に載せることを防ぐ。
  test.each([
    {
      name: "許可されていない PR の作成者",
      pr: { author: "mallory", headRepo: SAME_REPO },
      reason: "author_not_allowed",
      prAuthorLogin: "mallory",
    },
    {
      name: "PR の作成者を取得できない",
      pr: { author: null, headRepo: SAME_REPO },
      reason: "author_unknown",
      prAuthorLogin: null,
    },
    {
      name: "作成者が許可されていても、fork の PR",
      pr: { author: "alice", headRepo: { fullName: "alice/repo", fork: true } },
      reason: "fork",
      prAuthorLogin: "alice",
    },
    {
      name: "head の repository が削除されている（取得できない）",
      pr: { author: "alice", headRepo: null },
      reason: "head_repo_unknown",
      prAuthorLogin: "alice",
    },
  ])("$name は enqueue せず、監査ログに残す", async ({ pr, reason, prAuthorLogin }) => {
    const deps = makeDeps(pr);

    await handleIssueCommentEvent(makeEvent({ login: "alice" }), deps);

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith("webhook.issue_comment.origin.rejected", {
      event: "webhook.issue_comment.origin.rejected",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      reason,
      commenterLogin: "alice",
      prAuthorLogin,
    });
  });

  // 投稿者で拒否できるなら、PR を取得しない（GitHub API を呼ばない）。
  test.each([
    {
      name: "許可されていない投稿者",
      commentUser: { login: "mallory" },
      reason: "commenter_not_allowed",
      commenterLogin: "mallory",
    },
    {
      name: "投稿者が payload に無い",
      commentUser: undefined,
      reason: "commenter_unknown",
      commenterLogin: null,
    },
  ])("$name は PR を取得せず、enqueue せず、監査ログに残す", async (c) => {
    const deps = makeDeps({ author: "alice", headRepo: SAME_REPO });

    await handleIssueCommentEvent(makeEvent(c.commentUser), deps);

    expect(deps.getPullRequest).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith("webhook.issue_comment.origin.rejected", {
      event: "webhook.issue_comment.origin.rejected",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      reason: c.reason,
      commenterLogin: c.commenterLogin,
    });
  });

  test("PR の取得に失敗したら、enqueue せず例外のまま伝播する（fail-closed）", async () => {
    const deps = makeDeps(new Error("GitHub API pulls.get failed (status 502)"));

    await expect(handleIssueCommentEvent(makeEvent({ login: "alice" }), deps)).rejects.toThrow(
      "pulls.get failed",
    );

    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });

  test("再レビューを示さないコメントは、検証の対象にせず PR も取得しない", async () => {
    const deps = makeDeps({ author: "mallory", headRepo: SAME_REPO });
    const event = makeEvent({ login: "mallory" });
    (event.payload as { comment: { body: string } }).comment.body = "ordinary comment";

    await handleIssueCommentEvent(event, deps);

    expect(deps.getPullRequest).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      "webhook.issue_comment.origin.rejected",
      expect.anything(),
    );
  });

  test("allowlist が空（未設定）なら、PR を取得せず、拒否して監査ログに残す（fail-closed）", async () => {
    const deps = makeDeps({ author: "alice", headRepo: SAME_REPO }, { allowedAuthors: [] });

    await handleIssueCommentEvent(makeEvent({ login: "alice" }), deps);

    expect(deps.getPullRequest).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith(
      "webhook.issue_comment.origin.rejected",
      expect.objectContaining({ reason: "author_allowlist_empty", commenterLogin: "alice" }),
    );
  });
});
