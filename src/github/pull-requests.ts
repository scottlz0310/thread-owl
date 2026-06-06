// High-level pull request operations

import type { GitHubClient } from "./client.js";
import { getPullRequest, listPullRequestFiles } from "./rest.js";
import type { PullRequest, PullRequestFile } from "./rest.js";

export type { PullRequest, PullRequestFile };

export function getPR(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequest> {
  return getPullRequest(client, owner, repo, prNumber);
}

export function getPRFiles(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PullRequestFile[]> {
  return listPullRequestFiles(client, owner, repo, prNumber);
}

// summary / inline コメント投稿は #13 で実装する。
export async function postSummaryComment(
  _client: GitHubClient,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}

export async function postInlineComment(
  _client: GitHubClient,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _path: string,
  _line: number,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}
