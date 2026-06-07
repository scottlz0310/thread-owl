import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../src/config/logging.js";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  approvePR,
  getPR,
  getPRFiles,
  postInlineComment,
  postSummaryComment,
} from "../../../src/github/pull-requests.js";
import type { WriteContext } from "../../../src/github/write-context.js";
import { RepositoryNotAllowedError } from "../../../src/policy/allowlist.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("getPR / getPRFiles (high-level)", () => {
  it("getPR は PR 基本情報を返す", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 1,
        title: "t",
        body: null,
        state: "open",
        draft: false,
        head: { sha: "h", ref: "f" },
        base: { sha: "b", ref: "main" },
        html_url: "u",
      },
    });
    const client = { rest: { pulls: { get } } } as unknown as GitHubClient;

    const pr = await getPR(client, "o", "r", 1);

    expect(pr.number).toBe(1);
    expect(pr.head.sha).toBe("h");
  });

  it("getPRFiles は変更ファイル一覧を返す", async () => {
    const paginate = vi
      .fn()
      .mockResolvedValue([
        { filename: "a.ts", status: "modified", additions: 1, deletions: 2, patch: undefined },
      ]);
    const client = {
      rest: { pulls: { listFiles: vi.fn() }, paginate },
    } as unknown as GitHubClient;

    const files = await getPRFiles(client, "o", "r", 1);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("a.ts");
  });
});

describe("postSummaryComment", () => {
  it("allowlist 内なら issue comment を投稿し監査ログを残す", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 100 } });
    const logger = makeLogger();
    const ctx: WriteContext = {
      client: { rest: { issues: { createComment } } } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger,
    };

    await postSummaryComment(ctx, "o", "r", 7, "summary body");

    expect(createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 7,
      body: "summary body",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "review.summary_comment",
      expect.objectContaining({ owner: "o", repo: "r", prNumber: 7, commentId: 100 }),
    );
  });

  it("allowlist 外なら RepositoryNotAllowedError を throw し投稿しない", async () => {
    const createComment = vi.fn();
    const ctx: WriteContext = {
      client: { rest: { issues: { createComment } } } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };

    await expect(postSummaryComment(ctx, "evil", "repo", 7, "x")).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it("監査ログに body 全文を含めない", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const logger = makeLogger();
    const ctx: WriteContext = {
      client: { rest: { issues: { createComment } } } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger,
    };

    await postSummaryComment(ctx, "o", "r", 7, "SUPER_SECRET_BODY");

    const loggedMeta = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(JSON.stringify(loggedMeta)).not.toContain("SUPER_SECRET_BODY");
  });
});

describe("postInlineComment", () => {
  it("allowlist 内なら review comment を投稿し監査ログを残す", async () => {
    const createReviewComment = vi.fn().mockResolvedValue({ data: { id: 200 } });
    const logger = makeLogger();
    const ctx: WriteContext = {
      client: { rest: { pulls: { createReviewComment } } } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger,
    };

    await postInlineComment(ctx, "o", "r", 7, "sha", "src/a.ts", 10, "nit");

    expect(createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ commit_id: "sha", path: "src/a.ts", line: 10, body: "nit" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "review.inline_comment",
      expect.objectContaining({ path: "src/a.ts", line: 10, commentId: 200 }),
    );
  });

  it("allowlist 外なら throw し投稿しない", async () => {
    const createReviewComment = vi.fn();
    const ctx: WriteContext = {
      client: { rest: { pulls: { createReviewComment } } } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };

    await expect(postInlineComment(ctx, "evil", "repo", 7, "sha", "p", 1, "x")).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    expect(createReviewComment).not.toHaveBeenCalled();
  });
});

describe("approvePR", () => {
  function makeCtx(headSha: string, createReview: ReturnType<typeof vi.fn>): WriteContext {
    return {
      client: {
        rest: {
          pulls: {
            get: vi.fn().mockResolvedValue({
              data: {
                number: 7,
                title: "t",
                body: null,
                state: "open",
                draft: false,
                head: { sha: headSha, ref: "feat" },
                base: { sha: "base", ref: "main" },
                html_url: "u",
              },
            }),
            createReview,
          },
        },
      } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };
  }

  it("head SHA 一致なら APPROVE を呼び監査ログを残す", async () => {
    const createReview = vi.fn().mockResolvedValue({ data: { id: 42 } });
    const ctx = makeCtx("abc123", createReview);

    await approvePR(ctx, "o", "r", 7, "abc123");

    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({ commit_id: "abc123", event: "APPROVE" }),
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "review.approve",
      expect.objectContaining({ prNumber: 7, reviewId: 42, headSha: "abc123" }),
    );
  });

  it("head SHA 不一致なら throw し createReview を呼ばない", async () => {
    const createReview = vi.fn();
    const ctx = makeCtx("current-sha", createReview);

    await expect(approvePR(ctx, "o", "r", 7, "stale-sha")).rejects.toThrow("Head SHA mismatch");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("allowlist 外なら RepositoryNotAllowedError を throw し getPR を呼ばない", async () => {
    const createReview = vi.fn();
    const ctx = makeCtx("sha", createReview);
    ctx.allowedRepos = ["o/r"];

    await expect(approvePR(ctx, "evil", "repo", 7, "sha")).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    expect(createReview).not.toHaveBeenCalled();
  });
});
