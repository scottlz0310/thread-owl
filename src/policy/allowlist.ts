// Repository allowlist enforcement

export interface AllowlistConfig {
  repos: string[]; // format: "owner/repo"
}

// GitHub の owner/repo は大文字小文字を区別しないため小文字化して比較する。
// allowedRepos が空なら全拒否（fail-closed）。parseAllowlist の正規化仕様は #10 で実装する。
export function isAllowed(allowedRepos: readonly string[], owner: string, repo: string): boolean {
  const target = `${owner}/${repo}`.toLowerCase();
  return allowedRepos.some((entry) => entry.toLowerCase() === target);
}

export function parseAllowlist(_raw: string): AllowlistConfig {
  throw new Error("not implemented");
}
