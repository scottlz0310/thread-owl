import { describe, expect, test, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  type EnqueueReviewToolDeps,
  enqueueReviewTool,
} from "../../../src/mcp/tools/enqueue-review.js";
import { PullRequestOriginNotAllowedError } from "../../../src/policy/author-policy.js";
import { createReviewQueue } from "../../../src/queue/review-queue.js";
import { createReviewStatusStore } from "../../../src/queue/review-status.js";

interface PrData {
  user: { login: string; type: string } | null;
  headRepoFullName: string | null;
}

// pulls.get の応答（getPullRequest が読む項目だけ）。base の repository は org/repo。
function prResponse({ user, headRepoFullName }: PrData) {
  return {
    data: {
      number: 1,
      title: "t",
      body: null,
      state: "open",
      draft: false,
      user,
      head: {
        sha: "headsha",
        ref: "feature",
        repo: headRepoFullName === null ? null : { full_name: headRepoFullName },
      },
      base: { sha: "basesha", ref: "main", repo: { full_name: "org/repo" } },
      html_url: "https://github.com/org/repo/pull/1",
    },
  };
}

function makeDeps(
  pulls: { get: ReturnType<typeof vi.fn> },
  overrides: Partial<EnqueueReviewToolDeps> = {},
) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const getClient = vi.fn(async () => ({ rest: { pulls } }) as unknown as GitHubClient);
  const reviewStatus = createReviewStatusStore();
  const deps: EnqueueReviewToolDeps = {
    getClient,
    getWriteContext: async (): Promise<never> => {
      throw new Error("not used");
    },
    allowedRepos: ["org/repo"],
    allowedAuthors: ["alice"],
    logger,
    resolveInstallationId: async () => 123,
    queue: createReviewQueue(),
    reviewStatus,
    ...overrides,
  };
  return { deps, logger, getClient, reviewStatus };
}

const INPUT = { owner: "org", repo: "repo", prNumber: 1, reason: "opened" } as const;

describe("enqueue_review の作成者・fork の検証", () => {
  test("許可された作成者の同一 repository の PR は enqueue する", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        prResponse({ user: { login: "Alice", type: "User" }, headRepoFullName: "org/repo" }),
      );
    const { deps } = makeDeps({ get });

    await expect(enqueueReviewTool(deps, INPUT)).resolves.toEqual({ ok: true });

    expect(get).toHaveBeenCalledWith({ owner: "org", repo: "repo", pull_number: 1 });
    expect(deps.queue.list()).toHaveLength(1);
  });

  test.each([
    {
      name: "許可されていない作成者",
      data: { user: { login: "mallory", type: "User" }, headRepoFullName: "org/repo" },
      reason: "author_not_allowed",
      authorLogin: "mallory",
    },
    {
      name: "許可された作成者でも fork",
      data: { user: { login: "alice", type: "User" }, headRepoFullName: "alice/repo" },
      reason: "fork",
      authorLogin: "alice",
    },
    {
      name: "作成者を取得できない",
      data: { user: null, headRepoFullName: "org/repo" },
      reason: "author_unknown",
      authorLogin: null,
    },
    {
      name: "head の repository が削除されている",
      data: { user: { login: "alice", type: "User" }, headRepoFullName: null },
      reason: "head_repo_unknown",
      authorLogin: "alice",
    },
  ])(
    "$name は拒否し、enqueue も review status の更新もしない",
    async ({ data, reason, authorLogin }) => {
      const get = vi.fn().mockResolvedValue(prResponse(data));
      const { deps, logger, reviewStatus } = makeDeps({ get });

      const promise = enqueueReviewTool(deps, INPUT);

      await expect(promise).rejects.toBeInstanceOf(PullRequestOriginNotAllowedError);
      await expect(promise).rejects.toMatchObject({
        reason,
        owner: "org",
        repo: "repo",
        prNumber: 1,
      });
      expect(deps.queue.list()).toHaveLength(0);
      expect(reviewStatus.get({ owner: "org", repo: "repo", prNumber: 1 })).toBeUndefined();
      // 監査ログには作成者の login を残し、PR の本文・タイトルは残さない
      expect(logger.warn).toHaveBeenCalledWith("enqueue_review.origin.rejected", {
        event: "enqueue_review.origin.rejected",
        owner: "org",
        repo: "repo",
        prNumber: 1,
        reason,
        authorLogin,
      });
    },
  );

  test("PR を取得できなければ fail-closed で enqueue しない", async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const { deps } = makeDeps({ get });

    await expect(enqueueReviewTool(deps, INPUT)).rejects.toThrow("pulls.get failed (status 404)");

    expect(deps.queue.list()).toHaveLength(0);
  });

  test("requestedBy は検証に使わない（自己申告のため）", async () => {
    const get = vi
      .fn()
      .mockResolvedValue(
        prResponse({ user: { login: "mallory", type: "User" }, headRepoFullName: "org/repo" }),
      );
    const { deps } = makeDeps({ get });

    await expect(
      enqueueReviewTool(deps, { ...INPUT, reason: "re-review-requested", requestedBy: "alice" }),
    ).rejects.toBeInstanceOf(PullRequestOriginNotAllowedError);

    expect(deps.queue.list()).toHaveLength(0);
  });

  test("allowlist が空（未設定）なら、PR を取得せずに拒否する（fail-closed）", async () => {
    const get = vi.fn();
    const { deps, logger, getClient } = makeDeps({ get }, { allowedAuthors: [] });

    await expect(enqueueReviewTool(deps, INPUT)).rejects.toMatchObject({
      name: "PullRequestOriginNotAllowedError",
      reason: "author_allowlist_empty",
    });

    expect(getClient).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(deps.queue.list()).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "enqueue_review.origin.rejected",
      expect.objectContaining({ reason: "author_allowlist_empty", authorLogin: null }),
    );
  });

  test("リポジトリ allowlist 外は、PR を取得する前に拒否する", async () => {
    const get = vi.fn();
    const { deps, getClient } = makeDeps({ get }, { allowedRepos: ["other/repo"] });

    await expect(enqueueReviewTool(deps, INPUT)).rejects.toThrow("not in the allowlist");

    expect(getClient).not.toHaveBeenCalled();
  });
});
