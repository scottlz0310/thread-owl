// MCP tool: post_inline_comment

import { z } from "zod";
import { postInlineComment } from "../../github/pull-requests.js";
import type { ToolDeps } from "../tool-deps.js";

export const POST_INLINE_COMMENT_TOOL_NAME = "post_inline_comment";

export const postInlineCommentInputSchema = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  commitId: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  body: z.string().min(1),
};

type PostInlineCommentInput = z.infer<z.ZodObject<typeof postInlineCommentInputSchema>>;

export async function postInlineCommentTool(deps: ToolDeps, input: PostInlineCommentInput) {
  const ctx = await deps.getWriteContext(input.owner, input.repo);
  await postInlineComment(
    ctx,
    input.owner,
    input.repo,
    input.prNumber,
    input.commitId,
    input.path,
    input.line,
    input.body,
  );
  return { ok: true };
}
