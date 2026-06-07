import { describe, expect, test } from "vitest";
import { resolveAppMode } from "./mode.js";

describe("resolveAppMode", () => {
  test.each([
    { args: [], expected: "internal-api" },
    { args: ["--mcp"], expected: "mcp-stdio" },
    { args: ["--mcp-http"], expected: "mcp-http" },
    { args: ["--webhook"], expected: "webhook" },
    { args: ["--webhook-mcp-http"], expected: "webhook-mcp-http" },
  ])("$args → $expected", ({ args, expected }) => {
    expect(resolveAppMode(args)).toBe(expected);
  });

  test.each([
    ["--mcp", "--mcp-http"],
    ["--mcp", "--webhook"],
    ["--mcp-http", "--webhook"],
    ["--webhook", "--webhook-mcp-http"],
    ["--mcp", "--webhook-mcp-http"],
  ])("throws when %s and %s are combined", (a, b) => {
    expect(() => resolveAppMode([a, b])).toThrow();
  });
});
