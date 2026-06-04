// High-level pull request operations

import type { PullRequest, PullRequestFile } from "./rest.js";

export type { PullRequest, PullRequestFile };

export async function getPR(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
): Promise<PullRequest> {
  throw new Error("not implemented");
}

export async function getPRFiles(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
): Promise<PullRequestFile[]> {
  throw new Error("not implemented");
}

export async function postSummaryComment(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}

export async function postInlineComment(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _path: string,
  _line: number,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}
