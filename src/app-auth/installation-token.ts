// GitHub App installation access token issuance

import { createAppAuth } from "@octokit/auth-app";

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  installationId: number;
  repositoryIds?: number[];
  repositoryNames?: string[];
}

interface InstallationTokenAuthentication {
  token: string;
  expiresAt: string;
  installationId: number;
  repositoryIds?: number[];
  repositoryNames?: string[];
}

export interface InstallationTokenRepositoryScope {
  repositoryIds?: readonly number[];
  repositoryNames?: readonly string[];
}

type InstallationTokenAuth = (options: {
  type: "installation";
  installationId: number;
  repositoryIds?: number[];
  repositoryNames?: string[];
}) => Promise<InstallationTokenAuthentication>;

export interface GetInstallationTokenOptions extends InstallationTokenRepositoryScope {
  appId: string;
  privateKey: string;
  installationId: number;
  auth?: InstallationTokenAuth;
}

export async function getInstallationToken(
  options: GetInstallationTokenOptions,
): Promise<InstallationToken> {
  const scope = normalizeRepositoryScope(options);
  const auth =
    options.auth ??
    createAppAuth({
      appId: options.appId,
      privateKey: options.privateKey,
      installationId: options.installationId,
    });
  const authentication = await auth({
    type: "installation",
    installationId: options.installationId,
    ...scope,
  });

  return {
    token: authentication.token,
    expiresAt: new Date(authentication.expiresAt),
    installationId: authentication.installationId,
    // auth-app は要求が name のみでも repositoryIds/Names を両方返すため、TokenCache の
    // set/get キー対称性が崩れないよう、レスポンス値ではなく要求スコープを保持する。
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
