// MCP tool: post_inline_comment

export const POST_INLINE_COMMENT_TOOL_NAME = "post_inline_comment";

export interface PostInlineCommentInput {
  owner: string;
  repo: string;
  prNumber: number;
  path: string;
  line: number;
  body: string;
}

export async function postInlineCommentTool(_input: PostInlineCommentInput): Promise<void> {
  throw new Error("not implemented");
}
