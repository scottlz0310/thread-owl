import { describe, expect, it, vi } from "vitest";
import { getInstallationToken } from "../../../src/app-auth/installation-token.js";

describe("getInstallationToken", () => {
  it("@octokit/auth-app 互換 auth で installation access token を発行する", async () => {
    const auth = vi.fn().mockResolvedValue({
      token: "ghs_example",
      expiresAt: "2026-06-05T12:34:56Z",
      installationId: 12345,
    });

    const token = await getInstallationToken({
      appId: "123456",
      privateKey: "private-key",
      installationId: 12345,
      auth,
    });

    expect(token).toEqual({
      token: "ghs_example",
      expiresAt: new Date("2026-06-05T12:34:56Z"),
      installationId: 12345,
    });
    expect(auth).toHaveBeenCalledWith({ type: "installation", installationId: 12345 });
  });

  it("auth-app のエラーを呼び出し元に伝播する", async () => {
    const auth = vi.fn().mockRejectedValue(new Error("Bad credentials"));

    await expect(
      getInstallationToken({
        appId: "123456",
        privateKey: "bad-private-key",
        installationId: 12345,
        auth,
      }),
    ).rejects.toThrow("Bad credentials");
  });
});
