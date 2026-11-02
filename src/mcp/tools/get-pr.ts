// MCP tool: get_pr

import { z } from "zod";
import { getPR, getPRFiles } from "../../github/pull-requests.js";
import { evaluatePullRequestOrigin, pullRequestOrigin } from "../../policy/author-policy.js";
import type { ReviewStatusStore } from "../../queue/review-status.js";
import type { ToolDeps } from "../tool-deps.js";

export const GET_PR_TOOL_NAME = "get_pr";

export const getPrInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
};

type GetPrInput = z.infer<z.ZodObject<typeof getPrInputSchema>>;

export async function getPrTool(
  deps: ToolDeps & { reviewStatus?: ReviewStatusStore },
  input: GetPrInput,
) {
  // 非同期read中の次enqueueを、古いsnapshotに結び付けない。
  const attempt = deps.reviewStatus?.get(input);
  const client = await deps.getClient(input.owner, input.repo);
  const [pr, files] = await Promise.all([
    getPR(client, input.owner, input.repo, input.prNumber),
    getPRFiles(client, input.owner, input.repo, input.prNumber),
  ]);
  // enqueue_review と同じ判定の結果を返す。reviewer が、ローカル検証の前に、許可外の作成者・fork の PR を止められるようにする。
  // 許可リストの内容は返さない。get_pr 自体は拒否しない（拒否するかどうかは、呼び出し側が決める）。
  const origin = evaluatePullRequestOrigin(deps.allowedAuthors, pullRequestOrigin(pr));
  // origin は files の前に置く。files[].patch は大きく、クライアントは大きな応答の中間を省略する。
  // origin が末尾にあると省略に巻き込まれ、reviewer は origin.allowed を確認できずに止まる（fail-closed のため）。
  const reviewAttempt = attempt?.attemptId
    ? { attemptId: attempt.attemptId, headSha: attempt.attemptHeadSha, status: attempt.status }
    : null;
  return { pr, origin, reviewAttempt, files };
}
