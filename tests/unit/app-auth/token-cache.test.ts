import { describe, expect, it } from "vitest";
import type { InstallationToken } from "../../../src/app-auth/installation-token.js";
import { createTokenCache } from "../../../src/app-auth/token-cache.js";

function makeToken(overrides: Partial<InstallationToken> = {}): InstallationToken {
  return {
    token: "ghs_example",
    expiresAt: new Date("2026-06-05T12:00:00Z"),
    installationId: 12345,
    repositoryNames: ["octo-repo"],
    ...overrides,
  };
}

describe("createTokenCache", () => {
  it("installation_id と repository scope ごとに token を保存して取得する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:58:00Z") });
    const token = makeToken();

    cache.set(token);

    expect(cache.get({ installationId: 12345, repositoryNames: ["octo-repo"] })).toBe(token);
    expect(cache.get({ installationId: 67890, repositoryNames: ["octo-repo"] })).toBeUndefined();
    expect(cache.get({ installationId: 12345, repositoryNames: ["other-repo"] })).toBeUndefined();
  });

  it("repository scope は順序に依存せず同じ cache entry として扱う", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:58:00Z") });
    const token = makeToken({ repositoryNames: ["z-repo", "a-repo"] });

    cache.set(token);

    expect(cache.get({ installationId: 12345, repositoryNames: ["a-repo", "z-repo"] })).toBe(token);
  });

  it("repositoryIds scope でも token を保存して取得する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:58:00Z") });
    const token = makeToken({ repositoryNames: undefined, repositoryIds: [222, 111] });

    cache.set(token);

    expect(cache.get({ installationId: 12345, repositoryIds: [111, 222] })).toBe(token);
    expect(cache.get({ installationId: 12345, repositoryIds: [333] })).toBeUndefined();
  });

  it("期限切れ token は取得時に破棄する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T12:00:00Z") });
    const token = makeToken();

    cache.set(token);

    expect(cache.get({ installationId: 12345, repositoryNames: ["octo-repo"] })).toBeUndefined();
    expect(cache.get({ installationId: 12345, repositoryNames: ["octo-repo"] })).toBeUndefined();
  });

  it("デフォルトでは期限 60 秒前から token を期限切れ扱いにする", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:59:00Z") });
    const token = makeToken();

    cache.set(token);

    expect(cache.get({ installationId: 12345, repositoryNames: ["octo-repo"] })).toBeUndefined();
  });

  it("expiryBufferSeconds を指定できる", () => {
    const cache = createTokenCache({
      now: () => new Date("2026-06-05T11:59:00Z"),
      expiryBufferSeconds: 30,
    });
    const token = makeToken();

    cache.set(token);

    expect(cache.get({ installationId: 12345, repositoryNames: ["octo-repo"] })).toBe(token);
  });

  it("invalidate で token を明示的に削除する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:58:00Z") });
    const token = makeToken();

    cache.set(token);
    cache.invalidate({ installationId: 12345, repositoryNames: ["octo-repo"] });

    expect(cache.get({ installationId: 12345, repositoryNames: ["octo-repo"] })).toBeUndefined();
  });

  it("repository scope 未指定の cache entry は拒否する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:58:00Z") });

    expect(() => cache.get({ installationId: 12345 })).toThrow(
      "repositoryIds or repositoryNames is required",
    );
    expect(() => cache.set(makeToken({ repositoryNames: undefined }))).toThrow(
      "repositoryIds or repositoryNames is required",
    );
  });
});
