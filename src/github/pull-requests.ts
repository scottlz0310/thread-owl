// High-level pull request operations

import { assertRepoWritable } from "../policy/allowlist.js";
import type { GitHubClient } from "./client.js";
import type { PullRequest, PullRequestFile } from "./rest.js";
import {
  approvePullRequest,
  createIssueComment,
  createReviewComment,
  getPullRequest,
  listPullRequestFiles,
} from "./rest.js";
import {
  assertFullCommitSha,
  buildVerdictBody,
  normalizeVerdictSummary,
} from "./review-verdict.js";
import { auditWrite, type WriteContext } from "./write-context.js";

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
): Promise<number> {
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  const commentId = await createIssueComment(ctx.client, owner, repo, prNumber, body);
  auditWrite(ctx.logger, "summary_comment", {
    owner,
    repo,
    prNumber,
    commentId,
    bodyLength: body.length,
  });
  return commentId;
}

// Verdict コメントを固定書式で投稿する（allowlist ガード + head SHA 照合 + 監査ログ付き）。
// 本文はサーバー側で組み立て、headSha が現在の PR head と一致しない場合はエラーを throw する。
// 古い head に対する Verdict は reviewed 側のマージゲートを誤って通しかねないため。
export async function postReviewVerdict(
  ctx: WriteContext,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  summary: string,
): Promise<number> {
  assertFullCommitSha(headSha);
  normalizeVerdictSummary(summary);
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  const pr = await getPullRequest(ctx.client, owner, repo, prNumber);
  if (pr.head.sha !== headSha) {
    throw new Error(
      `Head SHA mismatch: expected ${headSha} but PR #${prNumber} head is ${pr.head.sha}`,
    );
  }
  const body = buildVerdictBody(summary, headSha);
  const commentId = await createIssueComment(ctx.client, owner, repo, prNumber, body);
  auditWrite(ctx.logger, "review_verdict", {
    owner,
    repo,
    prNumber,
    commentId,
    headSha,
    bodyLength: body.length,
  });
  return commentId;
}

// PR を APPROVE する（allowlist ガード + head SHA 照合 + 監査ログ付き）。
// expectedHeadSha が現在の PR head と一致しない場合はエラーを throw する。
// これにより呼び出し時点で未確認の commit を誤 APPROVE するリスクを防ぐ。
export async function approvePR(
  ctx: WriteContext,
  owner: string,
  repo: string,
  prNumber: number,
  expectedHeadSha: string,
  body?: string,
): Promise<void> {
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  const pr = await getPullRequest(ctx.client, owner, repo, prNumber);
  if (pr.head.sha !== expectedHeadSha) {
    throw new Error(
      `Head SHA mismatch: expected ${expectedHeadSha} but PR #${prNumber} head is ${pr.head.sha}`,
    );
  }
  const reviewId = await approvePullRequest(
    ctx.client,
    owner,
    repo,
    prNumber,
    expectedHeadSha,
    body,
  );
  auditWrite(ctx.logger, "approve", { owner, repo, prNumber, reviewId, headSha: expectedHeadSha });
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
