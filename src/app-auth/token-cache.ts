// Short-lived installation token cache with expiry management

import type { InstallationToken } from "./installation-token.js";

export interface TokenCache {
  get(installationId: number): InstallationToken | undefined;
  set(token: InstallationToken): void;
  invalidate(installationId: number): void;
}

export interface TokenCacheOptions {
  now?: () => Date;
  expiryBufferSeconds?: number;
}

const DEFAULT_EXPIRY_BUFFER_SECONDS = 60;

export function createTokenCache(options: TokenCacheOptions = {}): TokenCache {
  const tokens = new Map<number, InstallationToken>();
  const now = options.now ?? (() => new Date());
  const expiryBufferSeconds = options.expiryBufferSeconds ?? DEFAULT_EXPIRY_BUFFER_SECONDS;

  return {
    get(installationId) {
      const token = tokens.get(installationId);
      if (!token) return undefined;

      const expiresAtMs = token.expiresAt.getTime() - expiryBufferSeconds * 1000;
      if (expiresAtMs <= now().getTime()) {
        tokens.delete(installationId);
        return undefined;
      }

      return token;
    },
    set(token) {
      tokens.set(token.installationId, token);
    },
    invalidate(installationId) {
      tokens.delete(installationId);
    },
  };
}
