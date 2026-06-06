export type AppMode = "internal-api" | "mcp-stdio" | "mcp-http";

export function resolveAppMode(args: readonly string[]): AppMode {
  const modes = [
    args.includes("--mcp") ? "mcp-stdio" : undefined,
    args.includes("--mcp-http") ? "mcp-http" : undefined,
  ].filter((mode): mode is AppMode => mode !== undefined);

  if (modes.length > 1) {
    throw new Error("--mcp and --mcp-http cannot be used together");
  }

  return modes[0] ?? "internal-api";
}
