import { describe, expect, it, vi } from "vitest";
import { loadGitHubAppPrivateKey } from "../../../src/config/private-key.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("loadGitHubAppPrivateKey", () => {
  it("FILE 指定時はファイル内容をそのまま読み込む", () => {
    const readFile = vi.fn().mockReturnValue("FILE_KEY");
    const result = loadGitHubAppPrivateKey(
      { GITHUB_APP_PRIVATE_KEY_FILE: "/path/key.pem" },
      readFile,
    );
    expect(result).toBe("FILE_KEY");
    expect(readFile).toHaveBeenCalledWith("/path/key.pem");
  });

  it("B64 指定時は base64 をデコードする", () => {
    const result = loadGitHubAppPrivateKey({ GITHUB_APP_PRIVATE_KEY_B64: b64("B64_KEY") });
    expect(result).toBe("B64_KEY");
  });

  it("raw 指定時は \\n エスケープを改行に復元する", () => {
    const result = loadGitHubAppPrivateKey({ GITHUB_APP_PRIVATE_KEY: "line1\\nline2" });
    expect(result).toBe("line1\nline2");
  });

  describe("優先順位 FILE > B64 > raw", () => {
    it("FILE が最優先", () => {
      const readFile = vi.fn().mockReturnValue("FROM_FILE");
      const result = loadGitHubAppPrivateKey(
        {
          GITHUB_APP_PRIVATE_KEY_FILE: "/key.pem",
          GITHUB_APP_PRIVATE_KEY_B64: b64("FROM_B64"),
          GITHUB_APP_PRIVATE_KEY: "raw",
        },
        readFile,
      );
      expect(result).toBe("FROM_FILE");
    });

    it("FILE 無しなら B64 を優先する", () => {
      const result = loadGitHubAppPrivateKey({
        GITHUB_APP_PRIVATE_KEY_B64: b64("FROM_B64"),
        GITHUB_APP_PRIVATE_KEY: "raw",
      });
      expect(result).toBe("FROM_B64");
    });
  });

  it("どの形式も未設定の場合は undefined を返す", () => {
    expect(loadGitHubAppPrivateKey({})).toBeUndefined();
  });
});
