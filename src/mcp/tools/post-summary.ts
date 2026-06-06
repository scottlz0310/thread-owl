// MCP tool: post_summary_comment

import { z } from "zod";
import { postSummaryComment } from "../../github/pull-requests.js";
import type { ToolDeps } from "../tool-deps.js";

export const POST_SUMMARY_TOOL_NAME = "post_summary_comment";

export const postSummaryInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  body: z.string().min(1),
};

type PostSummaryInput = z.infer<z.ZodObject<typeof postSummaryInputSchema>>;

export async function postSummaryTool(deps: ToolDeps, input: PostSummaryInput) {
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  await postSummaryComment(ctx, input.owner, input.repo, input.prNumber, input.body);
  return { ok: true };
}
