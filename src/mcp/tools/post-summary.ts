// MCP tool: post_summary_comment

import { z } from "zod";
import { postSummaryComment } from "../../github/pull-requests.js";
import { assertNoVerdictContent } from "../../github/review-verdict.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import type { ToolDeps } from "../tool-deps.js";

export const POST_SUMMARY_TOOL_NAME = "post_summary_comment";

export const postSummaryInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  body: z.string().min(1),
  // レビュー対象にした head。review://status の headSha に記録する（省略時は null）。
  headSha: z.string().min(1).optional(),
};

type PostSummaryInput = z.infer<z.ZodObject<typeof postSummaryInputSchema>>;

export interface PostSummaryToolDeps extends ToolDeps {
  reviewStatus?: ReviewStatusStore;
}

export async function postSummaryTool(deps: PostSummaryToolDeps, input: PostSummaryInput) {
  // getWriteContext は installation token を発行するため、Verdict らしい本文では到達させない。
  assertNoVerdictContent(input.body);
  // 投稿の完了待ちの間に次ラウンドの enqueue_review が入った場合、その pending を上書きしないよう開始時に捕捉する。
  const round = deps.reviewStatus?.currentRound(input);
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  const summaryCommentId = await postSummaryComment(
    ctx,
    input.owner,
    input.repo,
    input.prNumber,
    input.body,
  );
  deps.reviewStatus?.markReviewed(input, { summaryCommentId, headSha: input.headSha, round });
  return { ok: true };
}
