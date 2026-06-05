// GitHub App installation access token issuance

import { Octokit } from "@octokit/rest";

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  installationId: number;
  repositoryIds?: number[];
  repositoryNames?: string[];
}

export interface InstallationTokenRepositoryScope {
  repositoryIds?: readonly number[];
  repositoryNames?: readonly string[];
}

interface CreateInstallationAccessTokenClient {
  rest: {
    apps: {
      createInstallationAccessToken(options: {
        installation_id: number;
        repository_ids?: number[];
        repositories?: string[];
      }): Promise<{ data: { token: string; expires_at: string } }>;
    };
  };
}

export interface GetInstallationTokenOptions extends InstallationTokenRepositoryScope {
  installationId: number;
  client?: CreateInstallationAccessTokenClient;
}

// generateAppJwt() が発行した App JWT を使い回して installation access token を取得する。
// 返す token には GitHub のレスポンス内容ではなく「要求スコープ」を保持する。
// TokenCache は要求スコープでキャッシュキーを引くため、set/get のキーを対称に保つ必要がある。
export async function getInstallationToken(
  appJwt: string,
  options: GetInstallationTokenOptions,
): Promise<InstallationToken> {
  const scope = normalizeRepositoryScope(options);
  const client = options.client ?? new Octokit({ auth: appJwt });

  const response = await client.rest.apps.createInstallationAccessToken({
    installation_id: options.installationId,
    ...(scope.repositoryIds ? { repository_ids: scope.repositoryIds } : {}),
    ...(scope.repositoryNames ? { repositories: scope.repositoryNames } : {}),
  });

  return {
    token: response.data.token,
    expiresAt: new Date(response.data.expires_at),
    installationId: options.installationId,
    ...(scope.repositoryIds ? { repositoryIds: scope.repositoryIds } : {}),
    ...(scope.repositoryNames ? { repositoryNames: scope.repositoryNames } : {}),
  };
}

export function normalizeRepositoryScope(scope: InstallationTokenRepositoryScope): {
  repositoryIds?: number[];
  repositoryNames?: string[];
} {
  const repositoryIds = scope.repositoryIds ? [...scope.repositoryIds].sort((a, b) => a - b) : [];
  const repositoryNames = scope.repositoryNames ? [...scope.repositoryNames].sort() : [];

  if (repositoryIds.length === 0 && repositoryNames.length === 0) {
    throw new Error("repositoryIds or repositoryNames is required to scope installation tokens");
  }

  return {
    ...(repositoryIds.length > 0 ? { repositoryIds } : {}),
    ...(repositoryNames.length > 0 ? { repositoryNames } : {}),
  };
}
