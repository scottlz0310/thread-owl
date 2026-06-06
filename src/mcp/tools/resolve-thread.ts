// MCP tool: resolve_review_thread

import { z } from "zod";
import { resolveThread } from "../../github/review-threads.js";
import type { ToolDeps } from "../tool-deps.js";

export const RESOLVE_THREAD_TOOL_NAME = "resolve_review_thread";

// owner/repo は installation token 取得に使う。allowlist 照合は threadId の実 repo で行う。
export const resolveThreadInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  threadId: z.string().min(1),
};

type ResolveThreadInput = z.infer<z.ZodObject<typeof resolveThreadInputSchema>>;

export async function resolveThreadTool(deps: ToolDeps, input: ResolveThreadInput) {
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  await resolveThread(ctx, input.threadId);
  return { ok: true };
}
