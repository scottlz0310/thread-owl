import { describe, expect, it, vi } from "vitest";
import {
  InstallationNotFoundError,
  resolveInstallationId,
} from "../../../src/app-auth/installation-resolver.js";

describe("resolveInstallationId", () => {
  it("owner/repo から GitHub App installation_id を解決する", async () => {
    const getRepoInstallation = vi.fn().mockResolvedValue({ data: { id: 12345 } });
    const client = { rest: { apps: { getRepoInstallation } } };

    const installationId = await resolveInstallationId("app-jwt", "octo-org", "octo-repo", {
      client,
    });

    expect(installationId).toBe(12345);
    expect(getRepoInstallation).toHaveBeenCalledWith({ owner: "octo-org", repo: "octo-repo" });
  });

  it("App が対象 repo にインストールされていない 404 を専用エラーに変換する", async () => {
    const notFoundError = Object.assign(new Error("Not Found"), { status: 404 });
    const client = {
      rest: { apps: { getRepoInstallation: vi.fn().mockRejectedValue(notFoundError) } },
    };

    await expect(
      resolveInstallationId("app-jwt", "octo-org", "missing-repo", { client }),
    ).rejects.toMatchObject({
      name: "InstallationNotFoundError",
      status: 404,
      owner: "octo-org",
      repo: "missing-repo",
      cause: notFoundError,
    });
    await expect(
      resolveInstallationId("app-jwt", "octo-org", "missing-repo", { client }),
    ).rejects.toBeInstanceOf(InstallationNotFoundError);
  });

  it("404 以外の GitHub API エラーを呼び出し元に伝播する", async () => {
    const error = Object.assign(new Error("Bad credentials"), { status: 401 });
    const client = {
      rest: { apps: { getRepoInstallation: vi.fn().mockRejectedValue(error) } },
    };

    await expect(
      resolveInstallationId("bad-jwt", "octo-org", "octo-repo", { client }),
    ).rejects.toBe(error);
  });
});
