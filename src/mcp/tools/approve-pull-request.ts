// MCP tool: approve_pull_request

import { z } from "zod";
import { approvePR } from "../../github/pull-requests.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import type { ToolDeps } from "../tool-deps.js";

export const APPROVE_PULL_REQUEST_TOOL_NAME = "approve_pull_request";

export const approvePullRequestInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  expectedHeadSha: z.string().min(1),
  body: z.string().optional(),
};

type ApprovePullRequestInput = z.infer<z.ZodObject<typeof approvePullRequestInputSchema>>;

export interface ApprovePullRequestToolDeps extends ToolDeps {
  reviewStatus?: ReviewStatusStore;
}

export async function approvePullRequestTool(
  deps: ApprovePullRequestToolDeps,
  input: ApprovePullRequestInput,
) {
  // approve の完了待ちの間に次ラウンドの enqueue_review が入った場合、その pending を上書きしないよう開始時に捕捉する。
  const round = deps.reviewStatus?.currentRound(input);
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  await approvePR(ctx, input.owner, input.repo, input.prNumber, input.expectedHeadSha, input.body);
  // approvePR が PR head との一致を照合済みなので、expectedHeadSha を承認した head として記録できる。
  deps.reviewStatus?.markApproved(input, { headSha: input.expectedHeadSha, round });
  return { ok: true };
}
