import { describe, expect, it, vi } from "vitest";
import { getInstallationToken } from "../../../src/app-auth/installation-token.js";

describe("getInstallationToken", () => {
  it("@octokit/auth-app 互換 auth で repositoryNames scope 付き installation access token を発行する", async () => {
    const auth = vi.fn().mockResolvedValue({
      token: "ghs_example",
      expiresAt: "2026-06-05T12:34:56Z",
      installationId: 12345,
      repositoryNames: ["octo-repo"],
    });

    const token = await getInstallationToken({
      appId: "123456",
      privateKey: "private-key",
      installationId: 12345,
      repositoryNames: ["octo-repo"],
      auth,
    });

    expect(token).toEqual({
      token: "ghs_example",
      expiresAt: new Date("2026-06-05T12:34:56Z"),
      installationId: 12345,
      repositoryNames: ["octo-repo"],
    });
    expect(auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 12345,
      repositoryNames: ["octo-repo"],
    });
  });

  it("repositoryIds scope を昇順で auth-app に渡して token に保持する", async () => {
    const auth = vi.fn().mockResolvedValue({
      token: "ghs_example",
      expiresAt: "2026-06-05T12:34:56Z",
      installationId: 12345,
    });

    const token = await getInstallationToken({
      appId: "123456",
      privateKey: "private-key",
      installationId: 12345,
      repositoryIds: [222, 111],
      auth,
    });

    expect(token.repositoryIds).toEqual([111, 222]);
    expect(token.repositoryNames).toBeUndefined();
    expect(auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 12345,
      repositoryIds: [111, 222],
    });
  });

  it("auth が返す実スコープではなく要求スコープを token に保持する", async () => {
    // auth-app は要求が name のみでも repositoryIds/Names を両方返すため、TokenCache の
    // set/get キーが一致するよう要求スコープのみを保持する（要求が name なら id を埋めない）。
    const auth = vi.fn().mockResolvedValue({
      token: "ghs_example",
      expiresAt: "2026-06-05T12:34:56Z",
      installationId: 12345,
      repositoryIds: [999],
      repositoryNames: ["octo-repo", "other-repo"],
    });

    const token = await getInstallationToken({
      appId: "123456",
      privateKey: "private-key",
      installationId: 12345,
      repositoryNames: ["octo-repo"],
      auth,
    });

    expect(token.repositoryIds).toBeUndefined();
    expect(token.repositoryNames).toEqual(["octo-repo"]);
  });

  it("repository scope 未指定の場合は installation-wide token を発行しない", async () => {
    const auth = vi.fn();

    await expect(
      getInstallationToken({
        appId: "123456",
        privateKey: "private-key",
        installationId: 12345,
        auth,
      }),
    ).rejects.toThrow("repositoryIds or repositoryNames is required");
    expect(auth).not.toHaveBeenCalled();
  });

  it("auth-app のエラーを呼び出し元に伝播する", async () => {
    const auth = vi.fn().mockRejectedValue(new Error("Bad credentials"));

    await expect(
      getInstallationToken({
        appId: "123456",
        privateKey: "bad-private-key",
        installationId: 12345,
        repositoryNames: ["octo-repo"],
        auth,
      }),
    ).rejects.toThrow("Bad credentials");
  });
});
