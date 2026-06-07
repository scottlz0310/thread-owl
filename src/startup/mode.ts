export type AppMode = "internal-api" | "mcp-stdio" | "mcp-http" | "webhook" | "webhook-mcp-http";

export function resolveAppMode(args: readonly string[]): AppMode {
  const modes = [
    args.includes("--mcp") ? "mcp-stdio" : undefined,
    args.includes("--mcp-http") ? "mcp-http" : undefined,
    args.includes("--webhook") ? "webhook" : undefined,
    args.includes("--webhook-mcp-http") ? "webhook-mcp-http" : undefined,
  ].filter((mode): mode is AppMode => mode !== undefined);

  if (modes.length > 1) {
    throw new Error("--mcp, --mcp-http, --webhook, and --webhook-mcp-http are mutually exclusive");
  }

  return modes[0] ?? "internal-api";
}
