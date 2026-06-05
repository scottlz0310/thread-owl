import { describe, expect, it, vi } from "vitest";
import { getInstallationToken } from "../../../src/app-auth/installation-token.js";

function makeClient(data: { token: string; expires_at: string } & Record<string, unknown>) {
  const createInstallationAccessToken = vi.fn().mockResolvedValue({ data });
  return {
    createInstallationAccessToken,
    client: { rest: { apps: { createInstallationAccessToken } } },
  };
}

describe("getInstallationToken", () => {
  it("App JWT と repositoryNames scope で installation access token を発行する", async () => {
    const { client, createInstallationAccessToken } = makeClient({
      token: "ghs_example",
      expires_at: "2026-06-05T12:34:56Z",
    });

    const token = await getInstallationToken("app-jwt", {
      installationId: 12345,
      repositoryNames: ["octo-repo"],
      client,
    });

    expect(token).toEqual({
      token: "ghs_example",
      expiresAt: new Date("2026-06-05T12:34:56Z"),
      installationId: 12345,
      repositoryNames: ["octo-repo"],
    });
    expect(createInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 12345,
      repositories: ["octo-repo"],
    });
  });

  it("repositoryIds scope を昇順で REST に渡して token に保持する", async () => {
    const { client, createInstallationAccessToken } = makeClient({
      token: "ghs_example",
      expires_at: "2026-06-05T12:34:56Z",
    });

    const token = await getInstallationToken("app-jwt", {
      installationId: 12345,
      repositoryIds: [222, 111],
      client,
    });

    expect(token.repositoryIds).toEqual([111, 222]);
    expect(token.repositoryNames).toBeUndefined();
    expect(createInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 12345,
      repository_ids: [111, 222],
    });
  });

  it("レスポンスの余剰 repository 情報ではなく要求スコープを token に保持する", async () => {
    // GitHub は repositories 配列を返すが、TokenCache の set/get キー対称性のため
    // token には要求スコープのみを保持する（要求が name のみなら id を埋めない）。
    const { client } = makeClient({
      token: "ghs_example",
      expires_at: "2026-06-05T12:34:56Z",
      repository_selection: "selected",
      repositories: [{ id: 999, name: "other-repo" }],
    });

    const token = await getInstallationToken("app-jwt", {
      installationId: 12345,
      repositoryNames: ["octo-repo"],
      client,
    });

    expect(token.repositoryIds).toBeUndefined();
    expect(token.repositoryNames).toEqual(["octo-repo"]);
  });

  it("repository scope 未指定の場合は installation-wide token を発行しない", async () => {
    const { client, createInstallationAccessToken } = makeClient({
      token: "ghs_example",
      expires_at: "2026-06-05T12:34:56Z",
    });

    await expect(
      getInstallationToken("app-jwt", { installationId: 12345, client }),
    ).rejects.toThrow("repositoryIds or repositoryNames is required");
    expect(createInstallationAccessToken).not.toHaveBeenCalled();
  });

  it("REST API のエラーを呼び出し元に伝播する", async () => {
    const createInstallationAccessToken = vi.fn().mockRejectedValue(new Error("Bad credentials"));
    const client = { rest: { apps: { createInstallationAccessToken } } };

    await expect(
      getInstallationToken("bad-jwt", {
        installationId: 12345,
        repositoryNames: ["octo-repo"],
        client,
      }),
    ).rejects.toThrow("Bad credentials");
  });
});
