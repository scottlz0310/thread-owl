// MCP tool: post_review_verdict

import { z } from "zod";
import { postReviewVerdict } from "../../github/pull-requests.js";
import { assertFullCommitSha, normalizeVerdictSummary } from "../../github/review-verdict.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import type { ToolDeps } from "../tool-deps.js";

export const POST_REVIEW_VERDICT_TOOL_NAME = "post_review_verdict";

export const postReviewVerdictInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  // レビュー対象にした head。現在の PR head と一致しない場合は投稿しない。
  headSha: z.string().min(1),
  // 見出しと `---` の間に入る自由記述部分。固定部分はサーバー側で組み立てる。
  summary: z.string().min(1),
};

type PostReviewVerdictInput = z.infer<z.ZodObject<typeof postReviewVerdictInputSchema>>;

export interface PostReviewVerdictToolDeps extends ToolDeps {
  reviewStatus?: ReviewStatusStore;
}

export async function postReviewVerdictTool(
  deps: PostReviewVerdictToolDeps,
  input: PostReviewVerdictInput,
) {
  // getWriteContext は installation token を発行するため GitHub の認証系 API を叩く。
  // 不正入力でそこへ到達しないよう、write context の取得より前に検証する。
  assertFullCommitSha(input.headSha);
  const summary = normalizeVerdictSummary(input.summary);
  // 投稿の完了待ちの間に次ラウンドの enqueue_review が入った場合、その pending を上書きしないよう開始時に捕捉する。
  const round = deps.reviewStatus?.currentRound(input);
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  const commentId = await postReviewVerdict(
    ctx,
    input.owner,
    input.repo,
    input.prNumber,
    input.headSha,
    summary,
  );
  // postReviewVerdict が PR head との一致を照合済みなので、headSha をレビュー対象として記録できる。
  deps.reviewStatus?.markReviewed(input, {
    summaryCommentId: commentId,
    headSha: input.headSha,
    round,
  });
  return { ok: true, commentId };
}
