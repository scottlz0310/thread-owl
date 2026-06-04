// MCP tool: get_pr

export const GET_PR_TOOL_NAME = "get_pr";

export interface GetPrInput {
  owner: string;
  repo: string;
  prNumber: number;
}

export async function getPrTool(_input: GetPrInput): Promise<unknown> {
  throw new Error("not implemented");
}
