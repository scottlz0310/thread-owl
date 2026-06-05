// GitHub App installation access token issuance

import { createAppAuth } from "@octokit/auth-app";

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  installationId: number;
}

interface InstallationTokenAuthentication {
  token: string;
  expiresAt: string;
  installationId: number;
}

type InstallationTokenAuth = (options: {
  type: "installation";
  installationId: number;
}) => Promise<InstallationTokenAuthentication>;

export interface GetInstallationTokenOptions {
  appId: string;
  privateKey: string;
  installationId: number;
  auth?: InstallationTokenAuth;
}

export async function getInstallationToken(
  options: GetInstallationTokenOptions,
): Promise<InstallationToken> {
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
  });

  return {
    token: authentication.token,
    expiresAt: new Date(authentication.expiresAt),
    installationId: authentication.installationId,
  };
}
