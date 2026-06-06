import { describe, expect, it } from "vitest";
import { loadEnv } from "../../../src/config/env.js";

const VALID_ENV = {
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
  ALLOWED_REPOS: "owner/repo",
  PORT: "3000",
  LOG_LEVEL: "info",
};

describe("loadEnv", () => {
  it("有効な環境変数を正しくパースする", () => {
    const config = loadEnv(VALID_ENV);
    expect(config.github.appId).toBe("123456");
    expect(config.github.webhookSecret).toBe("webhook-secret");
    expect(config.policy.allowedRepos).toEqual(["owner/repo"]);
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.logging.level).toBe("info");
  });

  it("GITHUB_APP_PRIVATE_KEY の \\n エスケープを改行に変換する", () => {
    const config = loadEnv({ ...VALID_ENV, GITHUB_APP_PRIVATE_KEY: "line1\\nline2" });
    expect(config.github.privateKey).toBe("line1\nline2");
  });

  it("GITHUB_APP_PRIVATE_KEY_B64 を base64 デコードして秘密鍵にする", () => {
    const { GITHUB_APP_PRIVATE_KEY: _, ...rest } = VALID_ENV;
    const b64 = Buffer.from("pem-content", "utf8").toString("base64");
    const config = loadEnv({ ...rest, GITHUB_APP_PRIVATE_KEY_B64: b64 });
    expect(config.github.privateKey).toBe("pem-content");
  });

  it("秘密鍵が FILE/B64/raw のいずれも未設定の場合はエラーを throw する", () => {
    const { GITHUB_APP_PRIVATE_KEY: _, ...rest } = VALID_ENV;
    expect(() => loadEnv(rest)).toThrow("Invalid configuration");
  });

  it("PORT 未設定の場合は 3000 をデフォルトにする", () => {
    const { PORT: _, ...env } = VALID_ENV;
    const config = loadEnv(env);
    expect(config.server.port).toBe(3000);
  });

  it("HOST 未設定の場合は 127.0.0.1 をデフォルトにする", () => {
    const config = loadEnv(VALID_ENV);
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("HOST が空文字列の場合も 127.0.0.1 にフォールバックする", () => {
    const config = loadEnv({ ...VALID_ENV, HOST: "" });
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("LOG_LEVEL 未設定の場合は info をデフォルトにする", () => {
    const { LOG_LEVEL: _, ...env } = VALID_ENV;
    const config = loadEnv(env);
    expect(config.logging.level).toBe("info");
  });

  it("ALLOWED_REPOS が複数エントリを正しくパースする", () => {
    const config = loadEnv({ ...VALID_ENV, ALLOWED_REPOS: "owner/repo1,owner/repo2" });
    expect(config.policy.allowedRepos).toEqual(["owner/repo1", "owner/repo2"]);
  });

  it("ALLOWED_REPOS 未設定の場合は空配列になる", () => {
    const { ALLOWED_REPOS: _, ...env } = VALID_ENV;
    const config = loadEnv(env);
    expect(config.policy.allowedRepos).toEqual([]);
  });

  it("ALLOWED_REPOS の前後空白をトリムする", () => {
    const config = loadEnv({ ...VALID_ENV, ALLOWED_REPOS: " owner/repo1 , owner/repo2 " });
    expect(config.policy.allowedRepos).toEqual(["owner/repo1", "owner/repo2"]);
  });

  it("ALLOWED_REPOS を小文字に正規化し重複を除去する", () => {
    const config = loadEnv({ ...VALID_ENV, ALLOWED_REPOS: "Owner/Repo,owner/repo" });
    expect(config.policy.allowedRepos).toEqual(["owner/repo"]);
  });

  it("ALLOWED_REPOS に owner/repo 形式でないエントリが含まれる場合はエラーを throw する", () => {
    expect(() => loadEnv({ ...VALID_ENV, ALLOWED_REPOS: "owner/repo,bad-entry" })).toThrow(
      "format",
    );
  });

  describe("必須変数が欠落している場合はエラーを throw する", () => {
    it.each([["GITHUB_APP_ID"], ["GITHUB_APP_PRIVATE_KEY"]] as const)("%s が欠落", (key) => {
      const env = { ...VALID_ENV, [key]: undefined };
      expect(() => loadEnv(env)).toThrow("Invalid configuration");
    });
  });

  it("GITHUB_WEBHOOK_SECRET 未設定でも起動できる", () => {
    const { GITHUB_WEBHOOK_SECRET: _, ...env } = VALID_ENV;
    const config = loadEnv(env);
    expect(config.github.webhookSecret).toBeUndefined();
  });

  it("MCP_HTTP_PATH が設定されている場合は server.mcpHttpPath に反映される", () => {
    const config = loadEnv({ ...VALID_ENV, MCP_HTTP_PATH: "/mcp/thread-owl" });
    expect(config.server.mcpHttpPath).toBe("/mcp/thread-owl");
  });

  it("MCP_HTTP_PATH 未設定の場合は /mcp をデフォルトにする", () => {
    const config = loadEnv(VALID_ENV);
    expect(config.server.mcpHttpPath).toBe("/mcp");
  });

  it("PORT が無効な数値の場合はエラーを throw する", () => {
    expect(() => loadEnv({ ...VALID_ENV, PORT: "abc" })).toThrow("Invalid configuration");
  });

  it("LOG_LEVEL が無効な値の場合はエラーを throw する", () => {
    expect(() => loadEnv({ ...VALID_ENV, LOG_LEVEL: "verbose" })).toThrow("Invalid configuration");
  });
});
