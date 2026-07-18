import { describe, expect, it } from "vitest";
import { resolveAppMode } from "../../../src/startup/mode.js";

describe("resolveAppMode", () => {
  it.each([
    [[], "internal-api"],
    [["--mcp"], "mcp-stdio"],
    [["--mcp-http"], "mcp-http"],
    [["--webhook"], "webhook"],
    [["--unknown"], "internal-api"],
  ] as const)("args=%j の起動モードは %s", (args, expected) => {
    expect(resolveAppMode(args)).toBe(expected);
  });

  it.each([[["--mcp", "--mcp-http"]], [["--mcp", "--webhook"]], [["--mcp-http", "--webhook"]]])(
    "複数モードの同時指定を拒否する: %j",
    (args) => {
      expect(() => resolveAppMode(args)).toThrow();
    },
  );
});
