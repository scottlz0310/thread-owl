// Short-lived installation token cache with expiry management

import type { InstallationToken, InstallationTokenRepositoryScope } from "./installation-token.js";

export interface InstallationTokenCacheKey extends InstallationTokenRepositoryScope {
  installationId: number;
}

export interface TokenCache {
  get(key: InstallationTokenCacheKey): InstallationToken | undefined;
  set(token: InstallationToken): void;
  invalidate(key: InstallationTokenCacheKey): void;
}

export interface TokenCacheOptions {
  now?: () => Date;
  expiryBufferSeconds?: number;
}

const DEFAULT_EXPIRY_BUFFER_SECONDS = 60;

export function createTokenCache(options: TokenCacheOptions = {}): TokenCache {
  const tokens = new Map<string, InstallationToken>();
  const now = options.now ?? (() => new Date());
  const expiryBufferSeconds = options.expiryBufferSeconds ?? DEFAULT_EXPIRY_BUFFER_SECONDS;

  return {
    get(key) {
      const cacheKey = makeCacheKey(key);
      const token = tokens.get(cacheKey);
      if (!token) return undefined;

      const expiresAtMs = token.expiresAt.getTime() - expiryBufferSeconds * 1000;
      if (expiresAtMs <= now().getTime()) {
        tokens.delete(cacheKey);
        return undefined;
      }

      return token;
    },
    set(token) {
      tokens.set(makeCacheKey(token), token);
    },
    invalidate(key) {
      tokens.delete(makeCacheKey(key));
    },
  };
}

function makeCacheKey(key: InstallationTokenCacheKey): string {
  const repositoryIds = key.repositoryIds ? [...key.repositoryIds].sort((a, b) => a - b) : [];
  const repositoryNames = key.repositoryNames ? [...key.repositoryNames].sort() : [];

  if (repositoryIds.length === 0 && repositoryNames.length === 0) {
    throw new Error(
      "repositoryIds or repositoryNames is required to scope installation token cache entries",
    );
  }

  return JSON.stringify({
    installationId: key.installationId,
    repositoryIds,
    repositoryNames,
  });
}
