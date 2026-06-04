// MCP tool: resolve_review_thread

export const RESOLVE_THREAD_TOOL_NAME = "resolve_review_thread";

export interface ResolveThreadInput {
  threadId: string;
}

export async function resolveThreadTool(_input: ResolveThreadInput): Promise<void> {
  throw new Error("not implemented");
}
