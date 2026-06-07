// Installation token broker endpoint
// Allows MCP clients and LLM frontends to obtain short-lived tokens

import type { AppJwt, AppJwtOptions } from "../app-auth/app-jwt.js";
import type { ResolveInstallationIdOptions } from "../app-auth/installation-resolver.js";
import type {
  GetInstallationTokenOptions,
  InstallationToken,
} from "../app-auth/installation-token.js";
import type { TokenCache } from "../app-auth/token-cache.js";
import type { Logger } from "../config/logging.js";
import type { AppConfig } from "../config/schema.js";
import { isAllowed, RepositoryNotAllowedError } from "../policy/allowlist.js";

export interface TokenSourceRequest {
  owner: string;
  repo: string;
}

export interface TokenSourceResponse {
  token: string;
  expiresAt: string;
}

export interface IssueTokenDeps {
  config: AppConfig;
  logger: Logger;
  tokenCache: TokenCache;
  generateAppJwt: (options: AppJwtOptions) => Promise<AppJwt>;
  resolveInstallationId: (
    appJwt: string,
    owner: string,
    repo: string,
    options?: ResolveInstallationIdOptions,
  ) => Promise<number>;
  getInstallationToken: (options: GetInstallationTokenOptions) => Promise<InstallationToken>;
}

// allowlist チェックは token 発行前に行う（拒否時は発行コストも secret 露出も発生させない）。
// 発行した token は repo スコープで cache し、再取得を抑制する。
export async function issueToken(
  request: TokenSourceRequest,
  deps: IssueTokenDeps,
): Promise<TokenSourceResponse> {
  const { owner, repo } = request;
  const { config, logger, tokenCache } = deps;

  if (!isAllowed(config.policy.allowedRepos, owner, repo)) {
    logger.warn("token.denied", { event: "token.denied", owner, repo });
    throw new RepositoryNotAllowedError(owner, repo);
  }

  const jwt = await deps.generateAppJwt({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
  });
  const installationId = await deps.resolveInstallationId(jwt.token, owner, repo);

  const cached = tokenCache.get({ installationId, repositoryNames: [repo] });
  if (cached) {
    logger.info("token.cache_hit", { event: "token.cache_hit", owner, repo, installationId });
    return toResponse(cached);
  }

  const token = await deps.getInstallationToken({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    installationId,
    repositoryNames: [repo],
  });
  tokenCache.set(token);
  logger.info("token.issued", { event: "token.issued", owner, repo, installationId });
  return toResponse(token);
}

function toResponse(token: InstallationToken): TokenSourceResponse {
  return { token: token.token, expiresAt: token.expiresAt.toISOString() };
}
