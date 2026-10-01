import { describe, expect, it } from "vitest";
import { loadEnv } from "../../../src/config/env.js";

const VALID_ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  ALLOWED_REPOS: "owner/repo",
};

describe("loadEnv: ALLOWED_AUTHORS", () => {
  it.each([
    { name: "未設定は空配列（検証しない。暫定）", value: undefined, expected: [] },
    { name: "空文字は未設定と同じ", value: "", expected: [] },
    {
      name: "複数の login を正規化する",
      value: " Alice , bob[bot] ,alice",
      expected: ["alice", "bob"],
    },
  ])("$name", ({ value, expected }) => {
    const config = loadEnv({ ...VALID_ENV, ALLOWED_AUTHORS: value });

    expect(config.policy.allowedAuthors).toEqual(expected);
  });

  it("形式不正は起動時に fail-fast で throw する", () => {
    expect(() => loadEnv({ ...VALID_ENV, ALLOWED_AUTHORS: "alice,owner/repo" })).toThrow(
      "ALLOWED_AUTHORS entry must be a GitHub login",
    );
  });
});
