// MCP tool: approve_pull_request

import { z } from "zod";
import { approvePR } from "../../github/pull-requests.js";
import type { ToolDeps } from "../tool-deps.js";

export const APPROVE_PULL_REQUEST_TOOL_NAME = "approve_pull_request";

export const approvePullRequestInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  body: z.string().optional(),
};

type ApprovePullRequestInput = z.infer<z.ZodObject<typeof approvePullRequestInputSchema>>;

export async function approvePullRequestTool(deps: ToolDeps, input: ApprovePullRequestInput) {
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  await approvePR(ctx, input.owner, input.repo, input.prNumber, input.body);
  return { ok: true };
}
