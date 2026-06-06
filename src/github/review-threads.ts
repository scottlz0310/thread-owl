// High-level review thread operations

import { assertRepoWritable } from "../policy/allowlist.js";
import type { GitHubClient } from "./client.js";
import { addReviewThreadReply, listReviewThreads, resolveReviewThread } from "./graphql.js";
import type { ReviewThread } from "./graphql.js";
import { type WriteContext, auditWrite } from "./write-context.js";

export type { ReviewThread };

// 未解決（unresolved）スレッドのみを返す高レベル API。
export async function listOpenThreads(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const threads = await listReviewThreads(client, owner, repo, prNumber);
  return threads.filter((thread) => !thread.isResolved);
}

// スレッドへ返信する（allowlist ガード + 監査ログ付き）。
export async function replyToThread(
  ctx: WriteContext,
  owner: string,
  repo: string,
  threadId: string,
  body: string,
): Promise<void> {
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  const commentId = await addReviewThreadReply(ctx.client, threadId, body);
  auditWrite(ctx.logger, "thread_reply", {
    owner,
    repo,
    threadId,
    commentId,
    bodyLength: body.length,
  });
}

// スレッドを resolve する（allowlist ガード + 監査ログ付き）。
export async function resolveThread(
  ctx: WriteContext,
  owner: string,
  repo: string,
  threadId: string,
): Promise<void> {
  assertRepoWritable(ctx.allowedRepos, owner, repo);
  await resolveReviewThread(ctx.client, threadId);
  auditWrite(ctx.logger, "thread_resolve", { owner, repo, threadId });
}
