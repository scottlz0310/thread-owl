// Installation token broker endpoint
// Allows MCP clients and LLM frontends to obtain short-lived tokens

export interface TokenSourceRequest {
  owner: string;
  repo: string;
}

export interface TokenSourceResponse {
  token: string;
  expiresAt: string;
}

export async function issueToken(_request: TokenSourceRequest): Promise<TokenSourceResponse> {
  throw new Error("not implemented");
}
