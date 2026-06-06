// GitHub REST API operations

import type { GitHubClient } from "./client.js";

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  htmlUrl: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | undefined;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

// Octokit 呼び出しを共通ラップし、失敗時に操作名と HTTP status をコンテキストとして付与する。
async function request<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    const status = (cause as { status?: number }).status;
    throw new Error(
      `GitHub API ${operation} failed${status !== undefined ? ` (status ${status})` : ""}`,
      { cause },
    );
  }
}

export async function getPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequest> {
  const { data } = await request("pulls.get", () =>
    client.rest.pulls.get({ owner, repo, pull_number: prNumber }),
  );
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    state: data.state,
    draft: data.draft ?? false,
    head: { sha: data.head.sha, ref: data.head.ref },
    base: { sha: data.base.sha, ref: data.base.ref },
    htmlUrl: data.html_url,
  };
}

export async function listPullRequestFiles(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestFile[]> {
  const files = await request("pulls.listFiles", () =>
    client.rest.paginate(client.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  );
  return files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  }));
}

// PR 本文へのサマリーコメント（issue comment）を投稿し、作成された comment id を返す。
export async function createIssueComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<number> {
  const { data } = await request("issues.createComment", () =>
    client.rest.issues.createComment({ owner, repo, issue_number: prNumber, body }),
  );
  return data.id;
}

// インラインレビューコメントを投稿し、作成された comment id を返す。
export async function createReviewComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  path: string,
  line: number,
  body: string,
): Promise<number> {
  const { data } = await request("pulls.createReviewComment", () =>
    client.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitId,
      path,
      line,
      body,
    }),
  );
  return data.id;
}

// review 全体投稿 / REST レビューコメント返信は現状未使用（将来用）。
export async function createReview(
  _client: GitHubClient,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _body: string,
  _event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  _comments?: InlineComment[],
): Promise<void> {
  throw new Error("not implemented");
}

export async function replyToReviewComment(
  _client: GitHubClient,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _commentId: number,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}
