// MCP tool: get_pr

import { z } from "zod";
import { getPR, getPRFiles } from "../../github/pull-requests.js";
import { evaluatePullRequestOrigin, pullRequestOrigin } from "../../policy/author-policy.js";
import type { ToolDeps } from "../tool-deps.js";

export const GET_PR_TOOL_NAME = "get_pr";

export const getPrInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
};

type GetPrInput = z.infer<z.ZodObject<typeof getPrInputSchema>>;

export async function getPrTool(deps: ToolDeps, input: GetPrInput) {
  const client = await deps.getClient(input.owner, input.repo);
  const [pr, files] = await Promise.all([
    getPR(client, input.owner, input.repo, input.prNumber),
    getPRFiles(client, input.owner, input.repo, input.prNumber),
  ]);
  // enqueue_review と同じ判定の結果を返す。reviewer が、ローカル検証の前に、許可外の作成者・fork の PR を止められるようにする。
  // 許可リストの内容は返さない。get_pr 自体は拒否しない（拒否するかどうかは、呼び出し側が決める）。
  const origin = evaluatePullRequestOrigin(deps.allowedAuthors, pullRequestOrigin(pr));
  return { pr, files, origin };
}
