// Short-lived installation token cache with expiry management

import type { InstallationToken } from "./installation-token.js";

export interface TokenCache {
  get(installationId: number): InstallationToken | undefined;
  set(token: InstallationToken): void;
  invalidate(installationId: number): void;
}

export function createTokenCache(): TokenCache {
  throw new Error("not implemented");
}
