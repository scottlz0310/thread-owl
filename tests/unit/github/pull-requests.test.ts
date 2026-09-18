import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../src/config/logging.js";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  approvePR,
  getPR,
  getPRFiles,
  postInlineComment,
  postReviewVerdict,
  postSummaryComment,
} from "../../../src/github/pull-requests.js";
import { InvalidVerdictInputError } from "../../../src/github/review-verdict.js";
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

    const commentId = await postSummaryComment(ctx, "o", "r", 7, "summary body");

    expect(commentId).toBe(100);

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

  it("通常本文中の Verdict の語だけなら issue comment を投稿する", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 101 } });
    const ctx: WriteContext = {
      client: { rest: { issues: { createComment } } } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };

    await expect(
      postSummaryComment(ctx, "o", "r", 7, "Verdict の根拠を確認しました"),
    ).resolves.toBe(101);
  });

  it.each([
    { name: "正式な Verdict 見出し", body: "## @thread-owl Review Verdict: APPROVED" },
    { name: "崩れた Verdict 見出し", body: "## Verdict" },
    { name: "本文中の Review Verdict", body: "レビュー完了。Review Verdict を参照してください" },
    { name: "CRLF の Verdict 見出し", body: "前段\r\n### Verdict\r\n後段" },
  ])("$name は投稿前に拒否する", async ({ body }) => {
    const createComment = vi.fn();
    const ctx: WriteContext = {
      client: { rest: { issues: { createComment } } } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };

    await expect(postSummaryComment(ctx, "o", "r", 7, body)).rejects.toThrow(
      InvalidVerdictInputError,
    );
    expect(createComment).not.toHaveBeenCalled();
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

describe("postReviewVerdict", () => {
  const headSha = "3facb641b17b1f31e9fb1895b558548cd48dcb78";

  function makeCtx(
    currentHeadSha: string,
    createComment: ReturnType<typeof vi.fn>,
    getBranchProtection = vi.fn().mockResolvedValue({
      data: { required_status_checks: null },
    }),
  ): WriteContext {
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: "t",
        body: null,
        state: "open",
        draft: false,
        head: { sha: currentHeadSha, ref: "feat" },
        base: { sha: "base", ref: "main" },
        html_url: "u",
      },
    });
    return {
      client: {
        rest: {
          pulls: { get },
          issues: { createComment },
          repos: {
            getBranchProtection,
            getBranchRules: vi.fn(),
            listCommitStatusesForRef: vi.fn(),
          },
          checks: { listForRef: vi.fn() },
          paginate: vi.fn().mockResolvedValue([]),
        },
      } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };
  }

  it("head SHA 一致なら固定書式の本文を投稿し comment ID を返す", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 100 } });
    const ctx = makeCtx(headSha, createComment);

    const commentId = await postReviewVerdict(ctx, "o", "r", 7, headSha, "本文");

    expect(commentId).toBe(100);
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "o",
        repo: "r",
        issue_number: 7,
        body: [
          "## @thread-owl Review Verdict: APPROVED",
          "",
          "本文",
          "",
          "---",
          `- Reviewed HEAD SHA: \`${headSha}\``,
          "- Status: `READY_TO_MERGE`",
        ].join("\n"),
      }),
    );
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "review.review_verdict",
      expect.objectContaining({ prNumber: 7, commentId: 100, headSha }),
    );
  });

  it("head SHA 不一致なら throw し投稿しない", async () => {
    const createComment = vi.fn();
    const ctx = makeCtx("0000000000000000000000000000000000000000", createComment);

    await expect(postReviewVerdict(ctx, "o", "r", 7, headSha, "本文")).rejects.toThrow(
      "Head SHA mismatch",
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it("branch protection の 403 では権限不足を記録し、Verdict を投稿しない", async () => {
    const createComment = vi.fn();
    const getBranchProtection = vi.fn().mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), {
        status: 403,
        response: {
          status: 403,
          data: { code: "integration_forbidden", status: "403" },
        },
      }),
    );
    const ctx = makeCtx(headSha, createComment, getBranchProtection);

    await expect(postReviewVerdict(ctx, "o", "r", 7, headSha, "本文")).rejects.toThrow(
      "Administration: read",
    );

    expect(createComment).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "review.review_verdict.required_checks_failed",
      expect.objectContaining({
        owner: "o",
        repo: "r",
        prNumber: 7,
        headSha,
        reason: "configuration",
        authPrincipal: "GitHub App installation token",
        requiredPermission: "Administration: read",
        apiOperation: "repos.getBranchProtection",
        apiStatus: 403,
        apiErrorCode: "integration_forbidden",
      }),
    );
  });

  it("required check の検証後に HEAD が変わったら投稿しない", async () => {
    const createComment = vi.fn();
    const get = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        data: {
          number: 7,
          title: "t",
          body: null,
          state: "open",
          draft: false,
          head: { sha: "0000000000000000000000000000000000000000", ref: "feat" },
          base: { sha: "base", ref: "main" },
          html_url: "u",
        },
      });
    const ctx: WriteContext = {
      client: {
        rest: {
          pulls: { get },
          issues: { createComment },
          repos: {
            getBranchProtection: vi.fn().mockResolvedValue({
              data: { required_status_checks: null },
            }),
            getBranchRules: vi.fn(),
            listCommitStatusesForRef: vi.fn(),
          },
          checks: { listForRef: vi.fn() },
          paginate: vi.fn().mockResolvedValue([]),
        },
      } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };

    await expect(postReviewVerdict(ctx, "o", "r", 7, headSha, "本文")).rejects.toThrow(
      "Head SHA changed during Verdict verification",
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  it.each([
    { name: "branch 名", headShaInput: "main", summary: "本文" },
    { name: "短縮 SHA", headShaInput: "3facb64", summary: "本文" },
    {
      name: "summary に固定の Status 行",
      headShaInput: headSha,
      summary: "- Status: `READY_TO_MERGE`",
    },
    { name: "summary に Review Verdict", headShaInput: headSha, summary: "前回の Review Verdict" },
  ])("$name は投稿前に拒否する（PR read もしない）", async ({ headShaInput, summary }) => {
    const createComment = vi.fn();
    const ctx = makeCtx(headSha, createComment);

    await expect(postReviewVerdict(ctx, "o", "r", 7, headShaInput, summary)).rejects.toThrow(
      InvalidVerdictInputError,
    );
    expect(ctx.client.rest.pulls.get).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
  });

  it("allowlist 外なら RepositoryNotAllowedError を throw し投稿しない", async () => {
    const createComment = vi.fn();
    const ctx = makeCtx(headSha, createComment);

    await expect(postReviewVerdict(ctx, "evil", "repo", 7, headSha, "本文")).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});
