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
  // review-raven 経由の候補（queue の項目の cycle.candidateId）に束縛して投稿する。指定時は cycle・round・HEAD を候補に固定し、
  // 結果索引へ記録する。省略時は従来どおり（旧経路）。
  candidateId: z
    .string()
    .regex(/^cand_[0-9a-z]{26}$/)
    .optional(),
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
  if (input.candidateId !== undefined) {
    return postBound(deps, input, summary, input.candidateId);
  }
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

// candidateId 指定の投稿。cycle・round・HEAD は候補に固定され、投稿時に現在の round を引き直さない。
async function postBound(
  deps: PostReviewVerdictToolDeps,
  input: PostReviewVerdictInput,
  summary: string,
  candidateId: string,
) {
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
      const id = await postReviewVerdict(
        ctx,
        input.owner,
        input.repo,
        input.prNumber,
        input.headSha,
        summary,
        marker,
      );
      return {
        id,
        url: `https://github.com/${input.owner}/${input.repo}/pull/${input.prNumber}#issuecomment-${id}`,
      };
    },
  });
  // 停止後の回復では write を実行せず、既存の投稿を返す。返す ID は、記録された結果の投稿から読む。
  return { ok: true, commentId: result.post.commentId, resultVersion: result.resultVersion };
}
