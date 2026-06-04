// MCP server setup
// TODO: implement with @modelcontextprotocol/sdk in Phase 3

export interface McpServerOptions {
  name: string;
  version: string;
}

export function createMcpServer(_options: McpServerOptions): unknown {
  throw new Error("not implemented");
}

export async function startMcpServer(_server: unknown): Promise<void> {
  throw new Error("not implemented");
}
