import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import type { WriteContext } from "../../../src/github/write-context.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";

vi.mock("../../../src/github/pull-requests.js");
vi.mock("../../../src/github/graphql.js");
vi.mock("../../../src/github/review-threads.js");

import * as graphql from "../../../src/github/graphql.js";
import * as pullRequests from "../../../src/github/pull-requests.js";
import * as reviewThreads from "../../../src/github/review-threads.js";
import { InvalidVerdictInputError } from "../../../src/github/review-verdict.js";
import { approvePullRequestTool } from "../../../src/mcp/tools/approve-pull-request.js";
import { getPrTool } from "../../../src/mcp/tools/get-pr.js";
import { listReviewThreadsTool } from "../../../src/mcp/tools/list-review-threads.js";
import { postInlineCommentTool } from "../../../src/mcp/tools/post-inline-comment.js";
import { postReviewVerdictTool } from "../../../src/mcp/tools/post-review-verdict.js";
import { postSummaryTool } from "../../../src/mcp/tools/post-summary.js";
import { replyThreadTool } from "../../../src/mcp/tools/reply-thread.js";
import { createReviewStatusStore } from "../../../src/queue/review-status.js";

const client = {} as GitHubClient;
const ctx = { client, allowedRepos: ["o/r"], logger: {} } as unknown as WriteContext;
const VERDICT_HEAD_SHA = "3facb641b17b1f31e9fb1895b558548cd48dcb78";

function makeDeps(): ToolDeps {
  return {
    getClient: vi.fn().mockResolvedValue(client),
    getWriteContext: vi.fn().mockResolvedValue(ctx),
  };
}

describe("MCP tools", () => {
  it("get_pr: client を取得し PR とファイルを返す", async () => {
    const deps = makeDeps();
    vi.mocked(pullRequests.getPR).mockResolvedValue({ number: 7 } as never);
    vi.mocked(pullRequests.getPRFiles).mockResolvedValue([]);

    const result = await getPrTool(deps, { owner: "o", repo: "r", prNumber: 7 });

    expect(deps.getClient).toHaveBeenCalledWith("o", "r");
    expect(pullRequests.getPR).toHaveBeenCalledWith(client, "o", "r", 7);
    expect(result).toEqual({ pr: { number: 7 }, files: [] });
  });

  it("list_review_threads: スレッド一覧を返す", async () => {
    const deps = makeDeps();
    vi.mocked(graphql.listReviewThreads).mockResolvedValue([{ id: "T1" }] as never);

    const result = await listReviewThreadsTool(deps, { owner: "o", repo: "r", prNumber: 7 });

    expect(graphql.listReviewThreads).toHaveBeenCalledWith(client, "o", "r", 7);
    expect(result).toEqual({ threads: [{ id: "T1" }] });
  });

  it("post_summary_comment: WriteContext で投稿する", async () => {
    const deps = makeDeps();
    vi.mocked(pullRequests.postSummaryComment).mockResolvedValue(100);

    const result = await postSummaryTool(deps, { owner: "o", repo: "r", prNumber: 7, body: "b" });

    expect(deps.getWriteContext).toHaveBeenCalledWith("o", "r");
    expect(pullRequests.postSummaryComment).toHaveBeenCalledWith(ctx, "o", "r", 7, "b");
    expect(result).toEqual({ ok: true });
  });

  it("post_summary_comment: Verdict らしい本文を WriteContext 取得前に拒否する", async () => {
    const reviewStatus = createReviewStatusStore();
    const pr = { owner: "o", repo: "r", prNumber: 7 };
    reviewStatus.markPending(pr);
    const deps = { ...makeDeps(), reviewStatus };
    const postSummaryComment = vi.mocked(pullRequests.postSummaryComment);
    postSummaryComment.mockClear();

    await expect(
      postSummaryTool(deps, {
        owner: "o",
        repo: "r",
        prNumber: 7,
        body: "## Verdict",
      }),
    ).rejects.toThrow(/post_review_verdict/);

    expect(deps.getWriteContext).not.toHaveBeenCalled();
    expect(postSummaryComment).not.toHaveBeenCalled();
    expect(reviewStatus.get(pr)).toMatchObject({ status: "pending", summaryCommentId: null });
  });

  it.each([
    { headSha: "abc123", expected: "abc123" },
    { headSha: undefined, expected: null },
  ])(
    "post_summary_comment: review status を reviewed にする（headSha=$headSha）",
    async ({ headSha, expected }) => {
      const reviewStatus = createReviewStatusStore();
      vi.mocked(pullRequests.postSummaryComment).mockResolvedValue(100);

      await postSummaryTool(
        { ...makeDeps(), reviewStatus },
        { owner: "o", repo: "r", prNumber: 7, body: "b", headSha },
      );

      expect(reviewStatus.get({ owner: "o", repo: "r", prNumber: 7 })).toMatchObject({
        status: "reviewed",
        summaryCommentId: 100,
        headSha: expected,
      });
    },
  );

  it("post_summary_comment: 投稿に失敗したら review status を更新しない", async () => {
    const reviewStatus = createReviewStatusStore();
    reviewStatus.markPending({ owner: "o", repo: "r", prNumber: 7 });
    vi.mocked(pullRequests.postSummaryComment).mockRejectedValue(new Error("boom"));

    await expect(
      postSummaryTool(
        { ...makeDeps(), reviewStatus },
        { owner: "o", repo: "r", prNumber: 7, body: "b" },
      ),
    ).rejects.toThrow("boom");

    expect(reviewStatus.get({ owner: "o", repo: "r", prNumber: 7 })?.status).toBe("pending");
  });

  it("post_review_verdict: WriteContext で投稿し comment ID を返す", async () => {
    const deps = makeDeps();
    vi.mocked(pullRequests.postReviewVerdict).mockResolvedValue(200);

    const result = await postReviewVerdictTool(deps, {
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: VERDICT_HEAD_SHA,
      summary: "s",
    });

    expect(deps.getWriteContext).toHaveBeenCalledWith("o", "r");
    expect(pullRequests.postReviewVerdict).toHaveBeenCalledWith(
      ctx,
      "o",
      "r",
      7,
      VERDICT_HEAD_SHA,
      "s",
    );
    expect(result).toEqual({ ok: true, commentId: 200 });
  });

  it("post_review_verdict: review status を reviewed にし headSha と comment ID を記録する", async () => {
    const reviewStatus = createReviewStatusStore();
    vi.mocked(pullRequests.postReviewVerdict).mockResolvedValue(200);

    await postReviewVerdictTool(
      { ...makeDeps(), reviewStatus },
      { owner: "o", repo: "r", prNumber: 7, headSha: VERDICT_HEAD_SHA, summary: "s" },
    );

    expect(reviewStatus.get({ owner: "o", repo: "r", prNumber: 7 })).toMatchObject({
      status: "reviewed",
      summaryCommentId: 200,
      headSha: VERDICT_HEAD_SHA,
    });
  });

  it("post_review_verdict: 投稿に失敗したら review status を更新しない", async () => {
    const reviewStatus = createReviewStatusStore();
    reviewStatus.markPending({ owner: "o", repo: "r", prNumber: 7 });
    vi.mocked(pullRequests.postReviewVerdict).mockRejectedValue(new Error("boom"));

    await expect(
      postReviewVerdictTool(
        { ...makeDeps(), reviewStatus },
        { owner: "o", repo: "r", prNumber: 7, headSha: VERDICT_HEAD_SHA, summary: "s" },
      ),
    ).rejects.toThrow("boom");

    expect(reviewStatus.get({ owner: "o", repo: "r", prNumber: 7 })?.status).toBe("pending");
  });

  it("post_review_verdict: 投稿中に次ラウンドが enqueue されたら pending を上書きしない", async () => {
    const reviewStatus = createReviewStatusStore();
    const pr = { owner: "o", repo: "r", prNumber: 7 };
    reviewStatus.markPending(pr);
    const updated = vi.fn();
    reviewStatus.onUpdated(updated);
    vi.mocked(pullRequests.postReviewVerdict).mockImplementation(async () => {
      reviewStatus.markPending(pr);
      return 200;
    });

    await postReviewVerdictTool(
      { ...makeDeps(), reviewStatus },
      { ...pr, headSha: VERDICT_HEAD_SHA, summary: "s" },
    );

    expect(reviewStatus.get(pr)?.status).toBe("pending");
    expect(updated).not.toHaveBeenCalled();
  });

  // getWriteContext は installation token を発行して GitHub の認証系 API を叩くため、
  // 不正入力ではそこへ到達しないことを MCP 経路で固定する。
  it.each([
    { name: "branch 名の headSha", headSha: "main", summary: "s" },
    { name: "短縮 SHA", headSha: "3facb64", summary: "s" },
    { name: "大文字を含む headSha", headSha: VERDICT_HEAD_SHA.toUpperCase(), summary: "s" },
    {
      name: "固定 Status 行の summary",
      headSha: VERDICT_HEAD_SHA,
      summary: "- Status: `READY_TO_MERGE`",
    },
    {
      name: "trim 後に固定行になる summary",
      headSha: VERDICT_HEAD_SHA,
      summary: "  - Status: `READY_TO_MERGE`  ",
    },
    {
      name: "Review Verdict を含む summary",
      headSha: VERDICT_HEAD_SHA,
      summary: "前回の Review Verdict",
    },
  ])(
    "post_review_verdict: $name は write context を取得する前に拒否する",
    async ({ headSha, summary }) => {
      const deps = makeDeps();
      const reviewStatus = createReviewStatusStore();
      reviewStatus.markPending({ owner: "o", repo: "r", prNumber: 7 });
      vi.mocked(pullRequests.postReviewVerdict).mockClear();

      await expect(
        postReviewVerdictTool(
          { ...deps, reviewStatus },
          { owner: "o", repo: "r", prNumber: 7, headSha, summary },
        ),
      ).rejects.toThrow(InvalidVerdictInputError);

      expect(deps.getWriteContext).not.toHaveBeenCalled();
      expect(pullRequests.postReviewVerdict).not.toHaveBeenCalled();
      expect(reviewStatus.get({ owner: "o", repo: "r", prNumber: 7 })?.status).toBe("pending");
    },
  );

  it("post_review_verdict: summary を trim してから渡す", async () => {
    const deps = makeDeps();
    vi.mocked(pullRequests.postReviewVerdict).mockResolvedValue(200);

    await postReviewVerdictTool(deps, {
      owner: "o",
      repo: "r",
      prNumber: 7,
      headSha: VERDICT_HEAD_SHA,
      summary: "  本文  ",
    });

    expect(pullRequests.postReviewVerdict).toHaveBeenCalledWith(
      ctx,
      "o",
      "r",
      7,
      VERDICT_HEAD_SHA,
      "本文",
    );
  });

  it("post_inline_comment: commitId/path/line 付きで投稿する", async () => {
    const deps = makeDeps();
    vi.mocked(pullRequests.postInlineComment).mockResolvedValue();

    await postInlineCommentTool(deps, {
      owner: "o",
      repo: "r",
      prNumber: 7,
      commitId: "sha",
      path: "p",
      line: 1,
      body: "b",
    });

    expect(pullRequests.postInlineComment).toHaveBeenCalledWith(
      ctx,
      "o",
      "r",
      7,
      "sha",
      "p",
      1,
      "b",
    );
  });

  it("reply_review_thread: threadId に返信する", async () => {
    const deps = makeDeps();
    vi.mocked(reviewThreads.replyToThread).mockResolvedValue();

    await replyThreadTool(deps, { owner: "o", repo: "r", threadId: "T1", body: "b" });

    expect(deps.getWriteContext).toHaveBeenCalledWith("o", "r");
    expect(reviewThreads.replyToThread).toHaveBeenCalledWith(ctx, "T1", "b");
  });

  it("approve_pull_request: expectedHeadSha を渡して APPROVE する", async () => {
    const deps = makeDeps();
    vi.mocked(pullRequests.approvePR).mockResolvedValue();

    const result = await approvePullRequestTool(deps, {
      owner: "o",
      repo: "r",
      prNumber: 7,
      expectedHeadSha: "abc123",
    });

    expect(deps.getWriteContext).toHaveBeenCalledWith("o", "r");
    expect(pullRequests.approvePR).toHaveBeenCalledWith(ctx, "o", "r", 7, "abc123", undefined);
    expect(result).toEqual({ ok: true });
  });

  it("post_summary_comment: 投稿中に次ラウンドが enqueue されたら pending を上書きしない", async () => {
    const reviewStatus = createReviewStatusStore();
    const pr = { owner: "o", repo: "r", prNumber: 7 };
    reviewStatus.markPending(pr);
    const updated = vi.fn();
    reviewStatus.onUpdated(updated);
    vi.mocked(pullRequests.postSummaryComment).mockImplementation(async () => {
      reviewStatus.markPending(pr);
      return 100;
    });

    await postSummaryTool({ ...makeDeps(), reviewStatus }, { ...pr, body: "b", headSha: "abc" });

    expect(reviewStatus.get(pr)).toMatchObject({ status: "pending", summaryCommentId: null });
    expect(updated).not.toHaveBeenCalled();
  });

  it("approve_pull_request: approve 中に次ラウンドが enqueue されたら pending を上書きしない", async () => {
    const reviewStatus = createReviewStatusStore();
    const pr = { owner: "o", repo: "r", prNumber: 7 };
    reviewStatus.markPending(pr);
    const updated = vi.fn();
    reviewStatus.onUpdated(updated);
    vi.mocked(pullRequests.approvePR).mockImplementation(async () => {
      reviewStatus.markPending(pr);
    });

    await approvePullRequestTool(
      { ...makeDeps(), reviewStatus },
      { ...pr, expectedHeadSha: "abc123" },
    );

    expect(reviewStatus.get(pr)?.status).toBe("pending");
    expect(updated).not.toHaveBeenCalled();
  });

  it("approve_pull_request: review status を照合済み head で approved にする", async () => {
    const reviewStatus = createReviewStatusStore();
    vi.mocked(pullRequests.approvePR).mockResolvedValue();

    await approvePullRequestTool(
      { ...makeDeps(), reviewStatus },
      { owner: "o", repo: "r", prNumber: 7, expectedHeadSha: "abc123" },
    );

    expect(reviewStatus.get({ owner: "o", repo: "r", prNumber: 7 })).toMatchObject({
      status: "approved",
      headSha: "abc123",
    });
  });

  it("approve_pull_request: approve に失敗したら review status を更新しない", async () => {
    const reviewStatus = createReviewStatusStore();
    vi.mocked(pullRequests.approvePR).mockRejectedValue(new Error("Head SHA mismatch"));

    await expect(
      approvePullRequestTool(
        { ...makeDeps(), reviewStatus },
        { owner: "o", repo: "r", prNumber: 7, expectedHeadSha: "stale" },
      ),
    ).rejects.toThrow("Head SHA mismatch");

    expect(reviewStatus.get({ owner: "o", repo: "r", prNumber: 7 })).toBeUndefined();
  });
});
