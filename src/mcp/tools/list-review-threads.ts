// MCP tool: list_review_threads

import { z } from "zod";
import { listReviewThreads } from "../../github/graphql.js";
import type { ToolDeps } from "../tool-deps.js";

export const LIST_REVIEW_THREADS_TOOL_NAME = "list_review_threads";

export const listReviewThreadsInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
};

type ListReviewThreadsInput = z.infer<z.ZodObject<typeof listReviewThreadsInputSchema>>;

export async function listReviewThreadsTool(deps: ToolDeps, input: ListReviewThreadsInput) {
  const client = await deps.getClient(input.owner, input.repo);
  const threads = await listReviewThreads(client, input.owner, input.repo, input.prNumber);
  return { threads };
}
