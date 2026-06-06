// High-level review thread operations

import { assertRepoWritable } from "../policy/allowlist.js";
import type { GitHubClient } from "./client.js";
import { addReviewThreadReply, getThreadRepository, listReviewThreads } from "./graphql.js";
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

// threadId の所属リポジトリを取得し allowlist と照合する。
// mutation は threadId のみで対象を決めるため、引数ではなく実 repo で判定して bypass を防ぐ。
async function assertThreadWritable(
  ctx: WriteContext,
  threadId: string,
): Promise<{ owner: string; repo: string }> {
  const target = await getThreadRepository(ctx.client, threadId);
  if (!target) {
    throw new Error(`Review thread ${threadId} not found`);
  }
  assertRepoWritable(ctx.allowedRepos, target.owner, target.repo);
  return target;
}

// スレッドへ返信する（threadId の所属 repo を allowlist 照合 + 監査ログ付き）。
export async function replyToThread(
  ctx: WriteContext,
  threadId: string,
  body: string,
): Promise<void> {
  const { owner, repo } = await assertThreadWritable(ctx, threadId);
  const commentId = await addReviewThreadReply(ctx.client, threadId, body);
  auditWrite(ctx.logger, "thread_reply", {
    owner,
    repo,
    threadId,
    commentId,
    bodyLength: body.length,
  });
}
