// MCP tool: approve_pull_request

import { z } from "zod";
import { approvePR } from "../../github/pull-requests.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import { appendMarker } from "../../review-cycle/correlation.js";
import type { ToolDeps } from "../tool-deps.js";

export const APPROVE_PULL_REQUEST_TOOL_NAME = "approve_pull_request";

export const approvePullRequestInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  expectedHeadSha: z.string().min(1),
  body: z.string().optional(),
  // review-raven 経由の候補（queue の項目の cycle.candidateId）に束縛して投稿する。指定時は cycle・round・HEAD を候補に固定し、
  // 結果索引へ記録する。省略時は従来どおり（旧経路）。
  candidateId: z
    .string()
    .regex(/^cand_[0-9a-z]{26}$/)
    .optional(),
};

type ApprovePullRequestInput = z.infer<z.ZodObject<typeof approvePullRequestInputSchema>>;

export interface ApprovePullRequestToolDeps extends ToolDeps {
  reviewStatus?: ReviewStatusStore;
}

export async function approvePullRequestTool(
  deps: ApprovePullRequestToolDeps,
  input: ApprovePullRequestInput,
) {
  if (input.candidateId !== undefined) {
    return approveBound(deps, input, input.candidateId);
  }
  // approve の完了待ちの間に次ラウンドの enqueue_review が入った場合、その pending を上書きしないよう開始時に捕捉する。
  const round = deps.reviewStatus?.currentRound(input);
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  await approvePR(ctx, input.owner, input.repo, input.prNumber, input.expectedHeadSha, input.body);
  // approvePR が PR head との一致を照合済みなので、expectedHeadSha を承認した head として記録できる。
  deps.reviewStatus?.markApproved(input, { headSha: input.expectedHeadSha, round });
  return { ok: true };
}

// candidateId 指定の承認。cycle・round・HEAD は候補に固定され、投稿時に現在の round を引き直さない。
async function approveBound(
  deps: ApprovePullRequestToolDeps,
  input: ApprovePullRequestInput,
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
    headSha: input.expectedHeadSha,
    kind: "approved",
    write: async (marker) => {
      const ctx = await deps.getWriteContext(input.owner, input.repo);
      const id = await approvePR(
        ctx,
        input.owner,
        input.repo,
        input.prNumber,
        input.expectedHeadSha,
        appendMarker(input.body ?? "", marker),
      );
      return {
        id,
        url: `https://github.com/${input.owner}/${input.repo}/pull/${input.prNumber}#pullrequestreview-${id}`,
      };
    },
  });
  return { ok: true, resultVersion: result.resultVersion };
}
