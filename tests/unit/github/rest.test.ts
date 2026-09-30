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
        user: { login: "author", type: "User" },
        head: { sha: "headsha", ref: "feature", repo: { full_name: "o/r", fork: false } },
        base: { sha: "basesha", ref: "main", repo: { full_name: "o/r" } },
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
      author: { login: "author", type: "User" },
      head: { sha: "headsha", ref: "feature", repo: { fullName: "o/r", fork: false } },
      base: { sha: "basesha", ref: "main" },
      htmlUrl: "https://github.com/o/r/pull/7",
    });
  });

  // head の repository が base と別なら fork。比較は full_name の大文字小文字を区別しない。
  // repo.fork（その repository が fork か）は使わない。base 自体が fork の場合、同一 repository の PR でも true になる。
  it.each([
    {
      name: "同一 repository の PR は fork ではない",
      headRepo: { full_name: "o/r", fork: false },
      baseRepo: { full_name: "o/r" },
      expected: { fullName: "o/r", fork: false },
    },
    {
      name: "別の repository からの PR は fork",
      headRepo: { full_name: "someone/r", fork: true },
      baseRepo: { full_name: "o/r" },
      expected: { fullName: "someone/r", fork: true },
    },
    {
      name: "full_name の大文字小文字が違うだけなら fork ではない",
      headRepo: { full_name: "O/R", fork: false },
      baseRepo: { full_name: "o/r" },
      expected: { fullName: "O/R", fork: false },
    },
    {
      name: "base 自体が fork でも、同一 repository の PR は fork ではない",
      headRepo: { full_name: "o/r", fork: true },
      baseRepo: { full_name: "o/r" },
      expected: { fullName: "o/r", fork: false },
    },
    {
      name: "head の repository が削除されている場合は null",
      headRepo: null,
      baseRepo: { full_name: "o/r" },
      expected: null,
    },
  ])("head の repository: $name", async ({ headRepo, baseRepo, expected }) => {
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: "t",
        body: null,
        state: "open",
        draft: false,
        user: { login: "author", type: "User" },
        head: { sha: "headsha", ref: "feature", repo: headRepo },
        base: { sha: "basesha", ref: "main", repo: baseRepo },
        html_url: "https://github.com/o/r/pull/7",
      },
    });

    const pr = await getPullRequest(makeClient({ pulls: { get } }), "o", "r", 7);

    expect(pr.head.repo).toEqual(expected);
  });

  it.each([
    {
      name: "User",
      user: { login: "author", type: "User" },
      expected: { login: "author", type: "User" },
    },
    {
      name: "Bot",
      user: { login: "renovate[bot]", type: "Bot" },
      expected: { login: "renovate[bot]", type: "Bot" },
    },
    { name: "取得できない（削除されたアカウント）", user: null, expected: null },
  ])("作成者: $name", async ({ user, expected }) => {
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 7,
        title: "t",
        body: null,
        state: "open",
        draft: false,
        user,
        head: { sha: "headsha", ref: "feature", repo: { full_name: "o/r", fork: false } },
        base: { sha: "basesha", ref: "main", repo: { full_name: "o/r" } },
        html_url: "https://github.com/o/r/pull/7",
      },
    });

    const pr = await getPullRequest(makeClient({ pulls: { get } }), "o", "r", 7);

    expect(pr.author).toEqual(expected);
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
