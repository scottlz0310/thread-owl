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
import { approvePullRequestTool } from "../../../src/mcp/tools/approve-pull-request.js";
import { getPrTool } from "../../../src/mcp/tools/get-pr.js";
import { listReviewThreadsTool } from "../../../src/mcp/tools/list-review-threads.js";
import { postInlineCommentTool } from "../../../src/mcp/tools/post-inline-comment.js";
import { postSummaryTool } from "../../../src/mcp/tools/post-summary.js";
import { replyThreadTool } from "../../../src/mcp/tools/reply-thread.js";

const client = {} as GitHubClient;
const ctx = { client, allowedRepos: ["o/r"], logger: {} } as unknown as WriteContext;

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
    vi.mocked(pullRequests.postSummaryComment).mockResolvedValue();

    const result = await postSummaryTool(deps, { owner: "o", repo: "r", prNumber: 7, body: "b" });

    expect(deps.getWriteContext).toHaveBeenCalledWith("o", "r");
    expect(pullRequests.postSummaryComment).toHaveBeenCalledWith(ctx, "o", "r", 7, "b");
    expect(result).toEqual({ ok: true });
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
});
