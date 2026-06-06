export type AppMode = "internal-api" | "mcp-stdio" | "mcp-http" | "webhook";

export function resolveAppMode(args: readonly string[]): AppMode {
  const modes = [
    args.includes("--mcp") ? "mcp-stdio" : undefined,
    args.includes("--mcp-http") ? "mcp-http" : undefined,
    args.includes("--webhook") ? "webhook" : undefined,
  ].filter((mode): mode is AppMode => mode !== undefined);

  if (modes.length > 1) {
    throw new Error("--mcp, --mcp-http, and --webhook cannot be combined");
  }

  return modes[0] ?? "internal-api";
}
