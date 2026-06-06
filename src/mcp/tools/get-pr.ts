// MCP tool: get_pr

import { z } from "zod";
import { getPR, getPRFiles } from "../../github/pull-requests.js";
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
  return { pr, files };
}
