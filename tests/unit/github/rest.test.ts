import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  createIssueComment,
  createReviewComment,
  getPullRequest,
  listPullRequestFiles,
} from "../../../src/github/rest.js";

function makeClient(rest: unknown): GitHubClient {
  return { rest } as unknown as GitHubClient;
}

describe("getPullRequest", () => {
  it("PR 基本情報（タイトル・状態・head SHA 等）を取得しマッピングする", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: "Add feature",
        body: "desc",
        state: "open",
        draft: false,
        head: { sha: "headsha", ref: "feature" },
        base: { sha: "basesha", ref: "main" },
        html_url: "https://github.com/o/r/pull/7",
      },
    });
    const client = makeClient({ pulls: { get } });

    const pr = await getPullRequest(client, "o", "r", 7);

    expect(get).toHaveBeenCalledWith({ owner: "o", repo: "r", pull_number: 7 });
    expect(pr).toEqual({
      number: 7,
      title: "Add feature",
      body: "desc",
      state: "open",
      draft: false,
      head: { sha: "headsha", ref: "feature" },
      base: { sha: "basesha", ref: "main" },
      htmlUrl: "https://github.com/o/r/pull/7",
    });
  });

  it("API エラー時は操作名と status を付与して throw する", async () => {
    const get = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    const client = makeClient({ pulls: { get } });

    await expect(getPullRequest(client, "o", "r", 999)).rejects.toThrow(
      "pulls.get failed (status 404)",
    );
  });
});

describe("listPullRequestFiles", () => {
  it("変更ファイル一覧（filename・additions・deletions）を取得する", async () => {
    const listFiles = vi.fn();
    const paginate = vi.fn().mockResolvedValue([
      { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" },
      { filename: "b.ts", status: "added", additions: 10, deletions: 0, patch: undefined },
    ]);
    const client = makeClient({ pulls: { listFiles }, paginate });

    const files = await listPullRequestFiles(client, "o", "r", 7);

    expect(paginate).toHaveBeenCalledWith(listFiles, {
      owner: "o",
      repo: "r",
      pull_number: 7,
      per_page: 100,
    });
    expect(files).toEqual([
      { filename: "a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@" },
      { filename: "b.ts", status: "added", additions: 10, deletions: 0, patch: undefined },
    ]);
  });
});

describe("createIssueComment", () => {
  it("issue comment を投稿し comment id を返す", async () => {
    const createComment = vi.fn().mockResolvedValue({ data: { id: 555 } });
    const client = makeClient({ issues: { createComment } });

    const id = await createIssueComment(client, "o", "r", 7, "summary");

    expect(createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 7,
      body: "summary",
    });
    expect(id).toBe(555);
  });
});

describe("createReviewComment", () => {
  it("review comment を投稿し comment id を返す", async () => {
    const createReviewCommentFn = vi.fn().mockResolvedValue({ data: { id: 777 } });
    const client = makeClient({ pulls: { createReviewComment: createReviewCommentFn } });

    const id = await createReviewComment(client, "o", "r", 7, "sha", "src/a.ts", 10, "nit");

    expect(createReviewCommentFn).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 7,
      commit_id: "sha",
      path: "src/a.ts",
      line: 10,
      body: "nit",
    });
    expect(id).toBe(777);
  });
});
