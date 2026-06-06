// MCP tool: reply_review_thread

import { z } from "zod";
import { replyToThread } from "../../github/review-threads.js";
import type { ToolDeps } from "../tool-deps.js";

export const REPLY_THREAD_TOOL_NAME = "reply_review_thread";

// owner/repo は installation token 取得に使う。allowlist 照合は threadId の実 repo で行う。
export const replyThreadInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  threadId: z.string().min(1),
  body: z.string().min(1),
};

type ReplyThreadInput = z.infer<z.ZodObject<typeof replyThreadInputSchema>>;

export async function replyThreadTool(deps: ToolDeps, input: ReplyThreadInput) {
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  await replyToThread(ctx, input.threadId, input.body);
  return { ok: true };
}
