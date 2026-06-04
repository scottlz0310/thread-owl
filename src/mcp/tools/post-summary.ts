// MCP tool: post_summary_comment

export const POST_SUMMARY_TOOL_NAME = "post_summary_comment";

export interface PostSummaryInput {
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}

export async function postSummaryTool(_input: PostSummaryInput): Promise<void> {
  throw new Error("not implemented");
}
