// MCP tool: reply_review_thread

export const REPLY_THREAD_TOOL_NAME = "reply_review_thread";

export interface ReplyThreadInput {
  owner: string;
  repo: string;
  prNumber: number;
  threadId: string;
  body: string;
}

export async function replyThreadTool(_input: ReplyThreadInput): Promise<void> {
  throw new Error("not implemented");
}
