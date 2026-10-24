import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../../config/logging.js";
import type { PullRequest } from "../../github/pull-requests.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { IngestMessage } from "../../review-cycle/ledger.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { handleIssueCommentEvent } from "./issue-comment.js";
import { handlePullRequestEvent } from "./pull-request.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function makeQueue(): ReviewQueue {
  return {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    removeCycle: vi.fn(() => false),
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

function prEvent(
  action: string,
  overrides: { draft?: boolean; author?: string; sha?: string | null; owner?: string } = {},
): NormalizedEvent {
  const { draft = false, author = "alice", sha = HEAD, owner = "Org" } = overrides;
  return {
    type: "pull_request",
    deliveryId: "0f1e2d3c-0001",
    installationId: 1,
    owner,
    repo: "Repo",
    prNumber: 7,
    payload: {
      action,
      pull_request: {
        number: 7,
        draft,
        user: { login: author },
        head: { ...(sha === null ? {} : { sha }), repo: { full_name: `${owner}/Repo` } },
      },
    },
  };
}

const TRUSTED_PR: PullRequest = {
  number: 7,
  title: "t",
  body: null,
  state: "open",
  draft: false,
  author: { login: "human-user", type: "User" },
  head: { sha: HEAD, ref: "feature", repo: { fullName: "org/repo", fork: false } },
  base: { sha: "basesha", ref: "main" },
  htmlUrl: "https://github.com/org/repo/pull/7",
};

function commentEvent(
  overrides: { commentId?: number; author?: string; body?: string } = {},
): NormalizedEvent {
  const {
    commentId = 6384673179,
    author = "human-user",
    body = "@thread-owl re-review requested",
  } = overrides;
  return {
    type: "issue_comment",
    deliveryId: "d-9",
    installationId: 1,
    owner: "Org",
    repo: "Repo",
    prNumber: 7,
    payload: {
      action: "created",
      issue: { number: 7, pull_request: { url: "u" } },
      comment: { ...(commentId === 0 ? {} : { id: commentId }), body, user: { login: author } },
    },
  };
}

function commentDeps(ingest: { record: (c: IngestMessage) => void }, pr: PullRequest = TRUSTED_PR) {
  return {
    queue: makeQueue(),
    logger: makeLogger(),
    allowedRepos: ["org/repo"],
    allowedAuthors: ["human-user"],
    getPullRequest: vi.fn().mockResolvedValue(pr),
    appSlug: "thread-owl",
    ingest,
  };
}

describe("pull_request: review-raven の共通受付への記録", () => {
  const base = () => ({
    queue: makeQueue(),
    logger: makeLogger(),
    allowedRepos: ["org/repo"],
    allowedAuthors: ["alice"],
  });

  test.each([
    ["opened", "opened"],
    ["synchronize", "synchronized"],
    ["ready_for_review", "opened"],
  ] as const)(
    "%s は、配送 ID を sourceId にして記録する（owner・repo は小文字）",
    async (action, reason) => {
      const ingest = { record: vi.fn() };
      await handlePullRequestEvent(prEvent(action), { ...base(), ingest });
      expect(ingest.record).toHaveBeenCalledWith({
        sourceId: "delivery:0f1e2d3c-0001",
        owner: "org",
        repo: "repo",
        prNumber: 7,
        headSha: HEAD,
        reason,
        delivery: "webhook",
      });
    },
  );

  test("旧経路の queue への投入は、記録の有無にかかわらず行い、記録は投入の後", async () => {
    const order: string[] = [];
    const deps = base();
    deps.queue.enqueue = vi.fn(() => void order.push("enqueue"));
    await handlePullRequestEvent(prEvent("opened"), {
      ...deps,
      ingest: { record: () => void order.push("ingest") },
    });
    expect(order).toEqual(["enqueue", "ingest"]);
  });

  test.each([
    ["draft", prEvent("opened", { draft: true })],
    ["許可外の作成者", prEvent("opened", { author: "mallory" })],
    ["allowlist 外の repo", prEvent("opened", { owner: "other" })],
    ["対象外の action", prEvent("closed")],
  ])("%s は記録しない", async (_name, event) => {
    const ingest = { record: vi.fn() };
    await handlePullRequestEvent(event, { ...base(), ingest });
    expect(ingest.record).not.toHaveBeenCalled();
  });

  test("payload に HEAD が無ければ記録しない（旧経路の queue には投入する）", async () => {
    const ingest = { record: vi.fn() };
    const deps = base();
    await handlePullRequestEvent(prEvent("opened", { sha: null }), { ...deps, ingest });
    expect(ingest.record).not.toHaveBeenCalled();
    expect(deps.queue.enqueue).toHaveBeenCalledOnce();
  });

  test("記録の窓口が無ければ（内部面が無効なら）、従来どおり", async () => {
    const deps = base();
    await handlePullRequestEvent(prEvent("opened"), deps);
    expect(deps.queue.enqueue).toHaveBeenCalledOnce();
  });

  test("記録に失敗したら握りつぶさず例外のまま伝播する（webhook が 500 を返し、再配信される）", async () => {
    await expect(
      handlePullRequestEvent(prEvent("opened"), {
        ...base(),
        ingest: {
          record: () => {
            throw new Error("db locked");
          },
        },
      }),
    ).rejects.toThrow("db locked");
  });
});

describe("issue_comment: review-raven の共通受付への記録", () => {
  test("再レビュー依頼は、コメント ID を sourceId にし、取得した PR の HEAD で記録する", async () => {
    const ingest = { record: vi.fn() };
    await handleIssueCommentEvent(commentEvent(), commentDeps(ingest));
    expect(ingest.record).toHaveBeenCalledWith({
      sourceId: "comment:6384673179",
      owner: "org",
      repo: "repo",
      prNumber: 7,
      headSha: HEAD,
      reason: "re-review-requested",
      delivery: "comment",
    });
  });

  test("コメント ID が無ければ、配送 ID を sourceId にする", async () => {
    const ingest = { record: vi.fn() };
    await handleIssueCommentEvent(commentEvent({ commentId: 0 }), commentDeps(ingest));
    expect(ingest.record).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "delivery:d-9", delivery: "comment" }),
    );
  });

  test.each([
    ["再レビュー依頼ではないコメント", commentEvent({ body: "LGTM" }), TRUSTED_PR],
    ["許可されていない投稿者", commentEvent({ author: "mallory" }), TRUSTED_PR],
    [
      "fork の PR",
      commentEvent(),
      { ...TRUSTED_PR, head: { ...TRUSTED_PR.head, repo: { fullName: "x/y", fork: true } } },
    ],
  ])("%s は記録しない", async (_name, event, pr) => {
    const ingest = { record: vi.fn() };
    await handleIssueCommentEvent(event, commentDeps(ingest, pr));
    expect(ingest.record).not.toHaveBeenCalled();
  });

  test("記録に失敗したら例外のまま伝播する", async () => {
    await expect(
      handleIssueCommentEvent(
        commentEvent(),
        commentDeps({
          record: () => {
            throw new Error("db locked");
          },
        }),
      ),
    ).rejects.toThrow("db locked");
  });
});
