// Repository allowlist enforcement

export interface AllowlistConfig {
  repos: string[]; // format: "owner/repo"
}

export function isAllowed(_allowlist: AllowlistConfig, _owner: string, _repo: string): boolean {
  throw new Error("not implemented");
}

export function parseAllowlist(_raw: string): AllowlistConfig {
  throw new Error("not implemented");
}
