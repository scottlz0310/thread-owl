import { describe, expect, it } from "vitest";
import { resolveAppMode } from "../../../src/startup/mode.js";

describe("resolveAppMode", () => {
  it.each([
    [[], "internal-api"],
    [["--mcp"], "mcp-stdio"],
    [["--mcp-http"], "mcp-http"],
    [["--unknown"], "internal-api"],
  ] as const)("args=%j の起動モードは %s", (args, expected) => {
    expect(resolveAppMode(args)).toBe(expected);
  });

  it("--mcp と --mcp-http の同時指定を拒否する", () => {
    expect(() => resolveAppMode(["--mcp", "--mcp-http"])).toThrow(
      "--mcp and --mcp-http cannot be used together",
    );
  });
});
