// Short-lived installation token cache with expiry management

import {
  type InstallationToken,
  type InstallationTokenRepositoryScope,
  normalizeRepositoryScope,
} from "./installation-token.js";

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

// installation token の有効期限は 1 時間。期限の 5 分前を safety margin として
// stale 扱いし、期限ギリギリのトークンで API 呼び出しが失敗するのを避ける。
const DEFAULT_EXPIRY_BUFFER_SECONDS = 300;

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

// get は呼び出し元の要求スコープ、set は getInstallationToken が要求スコープを保持した token を
// 渡すため、両者のキーは一致する。normalizeRepositoryScope で scope 必須・順序非依存を担保する。
function makeCacheKey(key: InstallationTokenCacheKey): string {
  const scope = normalizeRepositoryScope(key);

  return JSON.stringify({
    installationId: key.installationId,
    repositoryIds: scope.repositoryIds ?? [],
    repositoryNames: scope.repositoryNames ?? [],
  });
}
