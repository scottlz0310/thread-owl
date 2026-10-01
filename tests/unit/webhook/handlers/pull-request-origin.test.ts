import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../../../../src/config/logging.js";
import type { ReviewQueue } from "../../../../src/queue/review-queue.js";
import { handlePullRequestEvent } from "../../../../src/webhook/handlers/pull-request.js";
import type { NormalizedEvent } from "../../../../src/webhook/normalize-event.js";

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

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// base の repository は org/repo。pull_request の項目は、検証が読むもの（user・head.repo）を上書きできる。
function makeEvent(pullRequest: Record<string, unknown>): NormalizedEvent {
  return {
    type: "pull_request",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: {
      action: "opened",
      installation: { id: 1 },
      repository: { name: "repo", owner: { login: "org" } },
      pull_request: { number: 7, draft: false, ...pullRequest },
    },
  };
}

const ALLOWED_REPOS = ["org/repo"];
const ALLOWED_AUTHORS = ["alice"];

describe("pull_request webhook の作成者・fork の検証", () => {
  test("許可された作成者の同一 repository の PR は enqueue する", async () => {
    const queue = makeQueue();
    const event = makeEvent({
      user: { login: "Alice" },
      head: { repo: { full_name: "org/repo" } },
    });

    await handlePullRequestEvent(event, {
      queue,
      logger: makeLogger(),
      allowedRepos: ALLOWED_REPOS,
      allowedAuthors: ALLOWED_AUTHORS,
    });

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "org", repo: "repo", prNumber: 7 }),
    );
  });

  test.each([
    {
      name: "許可されていない作成者",
      pr: { user: { login: "mallory" }, head: { repo: { full_name: "org/repo" } } },
      reason: "author_not_allowed",
      authorLogin: "mallory",
    },
    {
      name: "許可された作成者でも fork",
      pr: { user: { login: "alice" }, head: { repo: { full_name: "alice/repo" } } },
      reason: "fork",
      authorLogin: "alice",
    },
    {
      name: "作成者が payload に無い",
      pr: { head: { repo: { full_name: "org/repo" } } },
      reason: "author_unknown",
      authorLogin: null,
    },
    {
      name: "作成者の login が文字列でない",
      pr: { user: { login: 123 }, head: { repo: { full_name: "org/repo" } } },
      reason: "author_unknown",
      authorLogin: null,
    },
    {
      name: "head の repository が null（削除された fork）",
      pr: { user: { login: "alice" }, head: { repo: null } },
      reason: "head_repo_unknown",
      authorLogin: "alice",
    },
    {
      name: "head が payload に無い",
      pr: { user: { login: "alice" } },
      reason: "head_repo_unknown",
      authorLogin: "alice",
    },
    {
      name: "head の repository の full_name が文字列でない",
      pr: { user: { login: "alice" }, head: { repo: { full_name: 1 } } },
      reason: "head_repo_unknown",
      authorLogin: "alice",
    },
  ])("$name は enqueue せず、監査ログに残す", async ({ pr, reason, authorLogin }) => {
    const queue = makeQueue();
    const logger = makeLogger();

    await handlePullRequestEvent(makeEvent(pr), {
      queue,
      logger,
      allowedRepos: ALLOWED_REPOS,
      allowedAuthors: ALLOWED_AUTHORS,
    });

    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("webhook.pull_request.origin.rejected", {
      event: "webhook.pull_request.origin.rejected",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      reason,
      authorLogin,
    });
    expect(logger.info).not.toHaveBeenCalledWith("webhook.pull_request.queued", expect.anything());
  });

  test("head の repository の比較は大文字小文字を区別しない", async () => {
    const queue = makeQueue();

    await handlePullRequestEvent(
      makeEvent({ user: { login: "alice" }, head: { repo: { full_name: "ORG/Repo" } } }),
      {
        queue,
        logger: makeLogger(),
        allowedRepos: ALLOWED_REPOS,
        allowedAuthors: ALLOWED_AUTHORS,
      },
    );

    expect(queue.enqueue).toHaveBeenCalled();
  });

  test("allowlist が空（未設定）なら、すべて拒否して監査ログに残す（fail-closed）", async () => {
    const queue = makeQueue();
    const logger = makeLogger();

    await handlePullRequestEvent(
      makeEvent({ user: { login: "alice" }, head: { repo: { full_name: "org/repo" } } }),
      {
        queue,
        logger,
        allowedRepos: ALLOWED_REPOS,
        allowedAuthors: [],
      },
    );

    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "webhook.pull_request.origin.rejected",
      expect.objectContaining({ reason: "author_allowlist_empty", authorLogin: "alice" }),
    );
  });
});
