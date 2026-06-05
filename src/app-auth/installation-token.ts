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
  const repositoryScope = normalizeRepositoryScope(options);
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
    ...repositoryScope,
  });

  return {
    token: authentication.token,
    expiresAt: new Date(authentication.expiresAt),
    installationId: authentication.installationId,
    repositoryIds: authentication.repositoryIds ?? repositoryScope.repositoryIds,
    repositoryNames: authentication.repositoryNames ?? repositoryScope.repositoryNames,
  };
}

function normalizeRepositoryScope(options: InstallationTokenRepositoryScope): {
  repositoryIds?: number[];
  repositoryNames?: string[];
} {
  const repositoryIds = options.repositoryIds
    ? [...options.repositoryIds].sort((a, b) => a - b)
    : [];
  const repositoryNames = options.repositoryNames ? [...options.repositoryNames].sort() : [];

  if (repositoryIds.length === 0 && repositoryNames.length === 0) {
    throw new Error("repositoryIds or repositoryNames is required to scope installation tokens");
  }

  return {
    ...(repositoryIds.length > 0 ? { repositoryIds } : {}),
    ...(repositoryNames.length > 0 ? { repositoryNames } : {}),
  };
}
