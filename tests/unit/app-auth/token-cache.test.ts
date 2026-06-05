import { describe, expect, it } from "vitest";
import type { InstallationToken } from "../../../src/app-auth/installation-token.js";
import { createTokenCache } from "../../../src/app-auth/token-cache.js";

function makeToken(overrides: Partial<InstallationToken> = {}): InstallationToken {
  return {
    token: "ghs_example",
    expiresAt: new Date("2026-06-05T12:00:00Z"),
    installationId: 12345,
    ...overrides,
  };
}

describe("createTokenCache", () => {
  it("installation_id ごとに token を保存して取得する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:58:00Z") });
    const token = makeToken();

    cache.set(token);

    expect(cache.get(12345)).toBe(token);
    expect(cache.get(67890)).toBeUndefined();
  });

  it("期限切れ token は取得時に破棄する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T12:00:00Z") });
    const token = makeToken();

    cache.set(token);

    expect(cache.get(12345)).toBeUndefined();
    expect(cache.get(12345)).toBeUndefined();
  });

  it("デフォルトでは期限 60 秒前から token を期限切れ扱いにする", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:59:00Z") });
    const token = makeToken();

    cache.set(token);

    expect(cache.get(12345)).toBeUndefined();
  });

  it("expiryBufferSeconds を指定できる", () => {
    const cache = createTokenCache({
      now: () => new Date("2026-06-05T11:59:00Z"),
      expiryBufferSeconds: 30,
    });
    const token = makeToken();

    cache.set(token);

    expect(cache.get(12345)).toBe(token);
  });

  it("invalidate で token を明示的に削除する", () => {
    const cache = createTokenCache({ now: () => new Date("2026-06-05T11:58:00Z") });
    const token = makeToken();

    cache.set(token);
    cache.invalidate(12345);

    expect(cache.get(12345)).toBeUndefined();
  });
});
