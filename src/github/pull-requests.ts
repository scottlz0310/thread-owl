// High-level pull request operations

import { assertRepoWritable } from "../policy/allowlist.js";
import type { GitHubClient } from "./client.js";
import {
  approvePullRequest,
  createIssueComment,
  createReviewComment,
  getPullRequest,
  listPullRequestFiles,
} from "./rest.js";
import type { PullRequest, PullRequestFile } from "./rest.js";
import { type WriteContext, auditWrite } from "./write-context.js";

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

// PR 本文へのサマリーコメントを投稿する（allowlist ガード + 監査ログ付き）。
export async function postSummaryComment(
  ctx: WriteContext,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  const commentId = await createIssueComment(ctx.client, owner, repo, prNumber, body);
  auditWrite(ctx.logger, "summary_comment", {
    owner,
    repo,
    prNumber,
    commentId,
    bodyLength: body.length,
  });
}

// PR を APPROVE する（allowlist ガード + 監査ログ付き）。
export async function approvePR(
  ctx: WriteContext,
  owner: string,
  repo: string,
  prNumber: number,
  body?: string,
): Promise<void> {
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  const reviewId = await approvePullRequest(ctx.client, owner, repo, prNumber, body);
  auditWrite(ctx.logger, "approve", { owner, repo, prNumber, reviewId });
}

// インラインレビューコメントを投稿する（allowlist ガード + 監査ログ付き）。
export async function postInlineComment(
  ctx: WriteContext,
  owner: string,
  repo: string,
  prNumber: number,
  commitId: string,
  path: string,
  line: number,
  body: string,
): Promise<void> {
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  const commentId = await createReviewComment(
    ctx.client,
    owner,
    repo,
    prNumber,
    commitId,
    path,
    line,
    body,
  );
  auditWrite(ctx.logger, "inline_comment", {
    owner,
    repo,
    prNumber,
    path,
    line,
    commentId,
    bodyLength: body.length,
  });
}
