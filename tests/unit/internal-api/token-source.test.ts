import { describe, expect, it, vi } from "vitest";
import { InstallationNotFoundError } from "../../../src/app-auth/installation-resolver.js";
import type { InstallationToken } from "../../../src/app-auth/installation-token.js";
import type { TokenCache } from "../../../src/app-auth/token-cache.js";
import type { Logger } from "../../../src/config/logging.js";
import type { AppConfig } from "../../../src/config/schema.js";
import { RepositoryNotAllowedError, issueToken } from "../../../src/internal-api/token-source.js";

const PRIVATE_KEY = "private-key-secret";
const APP_JWT = "jwt-secret";
const INSTALLATION_TOKEN = "ghs_secret";

function makeConfig(allowedRepos: string[]): AppConfig {
  return {
    github: { appId: "123456", privateKey: PRIVATE_KEY, webhookSecret: "ws" },
    policy: { allowedRepos },
    server: { port: 3000, host: "127.0.0.1" },
    logging: { level: "info" },
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeToken(overrides: Partial<InstallationToken> = {}): InstallationToken {
  return {
    token: INSTALLATION_TOKEN,
    expiresAt: new Date("2026-06-05T12:00:00Z"),
    installationId: 999,
    repositoryNames: ["octo-repo"],
    ...overrides,
  };
}

function makeCache(initial?: InstallationToken): TokenCache {
  return { get: vi.fn(() => initial), set: vi.fn(), invalidate: vi.fn() };
}

function baseDeps() {
  return {
    generateAppJwt: vi.fn().mockResolvedValue({ token: APP_JWT, expiresAt: new Date() }),
    resolveInstallationId: vi.fn().mockResolvedValue(999),
    getInstallationToken: vi.fn().mockResolvedValue(makeToken()),
  };
}

describe("issueToken", () => {
  it("allowlist 外は token 発行前に拒否し、auth 系を呼ばない", async () => {
    const deps = {
      config: makeConfig([]),
      logger: makeLogger(),
      tokenCache: makeCache(),
      ...baseDeps(),
    };

    await expect(issueToken({ owner: "octo-org", repo: "octo-repo" }, deps)).rejects.toBeInstanceOf(
      RepositoryNotAllowedError,
    );
    expect(deps.generateAppJwt).not.toHaveBeenCalled();
    expect(deps.resolveInstallationId).not.toHaveBeenCalled();
    expect(deps.getInstallationToken).not.toHaveBeenCalled();
  });

  it("cache ミス時に token を発行して cache に保存する", async () => {
    const cache = makeCache(undefined);
    const deps = {
      config: makeConfig(["octo-org/octo-repo"]),
      logger: makeLogger(),
      tokenCache: cache,
      ...baseDeps(),
    };

    const res = await issueToken({ owner: "octo-org", repo: "octo-repo" }, deps);

    expect(res).toEqual({ token: INSTALLATION_TOKEN, expiresAt: "2026-06-05T12:00:00.000Z" });
    expect(deps.getInstallationToken).toHaveBeenCalledWith({
      appId: "123456",
      privateKey: PRIVATE_KEY,
      installationId: 999,
      repositoryNames: ["octo-repo"],
    });
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("cache ヒット時は token 発行をスキップする", async () => {
    const deps = {
      config: makeConfig(["octo-org/octo-repo"]),
      logger: makeLogger(),
      tokenCache: makeCache(makeToken({ token: "ghs_cached" })),
      ...baseDeps(),
    };

    const res = await issueToken({ owner: "octo-org", repo: "octo-repo" }, deps);

    expect(res.token).toBe("ghs_cached");
    expect(deps.getInstallationToken).not.toHaveBeenCalled();
  });

  it("InstallationNotFoundError を呼び出し元に伝播する", async () => {
    const deps = {
      config: makeConfig(["octo-org/octo-repo"]),
      logger: makeLogger(),
      tokenCache: makeCache(undefined),
      ...baseDeps(),
    };
    deps.resolveInstallationId = vi
      .fn()
      .mockRejectedValue(new InstallationNotFoundError("octo-org", "octo-repo"));

    await expect(issueToken({ owner: "octo-org", repo: "octo-repo" }, deps)).rejects.toBeInstanceOf(
      InstallationNotFoundError,
    );
  });

  it("logger 引数に secret（token/privateKey/JWT）を含めない", async () => {
    const logger = makeLogger();
    const deps = {
      config: makeConfig(["octo-org/octo-repo"]),
      logger,
      tokenCache: makeCache(undefined),
      ...baseDeps(),
    };

    await issueToken({ owner: "octo-org", repo: "octo-repo" }, deps);

    const calls = [
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(INSTALLATION_TOKEN);
    expect(serialized).not.toContain(APP_JWT);
    expect(serialized).not.toContain(PRIVATE_KEY);
  });
});
