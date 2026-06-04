// MCP tool: list_review_threads

export const LIST_REVIEW_THREADS_TOOL_NAME = "list_review_threads";

export interface ListReviewThreadsInput {
  owner: string;
  repo: string;
  prNumber: number;
}

export async function listReviewThreadsTool(_input: ListReviewThreadsInput): Promise<unknown> {
  throw new Error("not implemented");
}
