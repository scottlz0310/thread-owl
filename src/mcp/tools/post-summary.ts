// MCP tool: post_summary_comment

import { z } from "zod";
import { postSummaryComment } from "../../github/pull-requests.js";
import { assertNoVerdictContent } from "../../github/review-verdict.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import { appendMarker } from "../../review-cycle/correlation.js";
import type { ToolDeps } from "../tool-deps.js";

export const POST_SUMMARY_TOOL_NAME = "post_summary_comment";

export const postSummaryInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  body: z.string().min(1),
  // レビュー対象にした head。review://status の headSha に記録する（省略時は null）。
  headSha: z.string().min(1).optional(),
  // review-raven 経由の候補（queue の項目の cycle.candidateId）に束縛して投稿する。指定時は cycle・round・HEAD を候補に固定し、
  // 結果索引へ記録する。省略時は従来どおり（旧経路）。
  candidateId: z
    .string()
    .regex(/^cand_[0-9a-z]{26}$/)
    .optional(),
};

type PostSummaryInput = z.infer<z.ZodObject<typeof postSummaryInputSchema>>;

export interface PostSummaryToolDeps extends ToolDeps {
  reviewStatus?: ReviewStatusStore;
}

export async function postSummaryTool(deps: PostSummaryToolDeps, input: PostSummaryInput) {
  // getWriteContext は installation token を発行するため、Verdict らしい本文では到達させない。
  assertNoVerdictContent(input.body);
  if (input.candidateId !== undefined) {
    return postBound(deps, input, input.candidateId);
  }
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

// candidateId 指定の投稿。cycle・round・HEAD は候補に固定され、投稿時に現在の round を引き直さない。
async function postBound(deps: PostSummaryToolDeps, input: PostSummaryInput, candidateId: string) {
  const binder = deps.resultBinder;
  if (!binder) {
    throw new Error(
      "candidateId を使うには、内部面（review-raven との連携）を有効にする必要がある",
    );
  }
  const result = await binder.post({
    candidateId,
    pr: input,
    headSha: input.headSha,
    kind: "reviewed",
    write: async (marker) => {
      const ctx = await deps.getWriteContext(input.owner, input.repo);
      const id = await postSummaryComment(
        ctx,
        input.owner,
        input.repo,
        input.prNumber,
        appendMarker(input.body, marker),
      );
      return {
        id,
        url: `https://github.com/${input.owner}/${input.repo}/pull/${input.prNumber}#issuecomment-${id}`,
      };
    },
  });
  return { ok: true, resultVersion: result.resultVersion };
}
