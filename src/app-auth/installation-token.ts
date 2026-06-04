// GitHub App installation access token issuance
// TODO: implement with @octokit/auth-app in Phase 1

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  installationId: number;
}

export async function getInstallationToken(
  _appJwt: string,
  _installationId: number,
): Promise<InstallationToken> {
  throw new Error("not implemented");
}
