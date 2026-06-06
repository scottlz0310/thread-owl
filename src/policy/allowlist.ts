// Repository allowlist enforcement

export interface AllowlistConfig {
  repos: string[]; // format: "owner/repo"
}

// owner/repo または owner/* を受け付ける。* は owner 内全 repo を許可。
// owner 部分に * は禁止（全 owner 許可は安全でないため fail-closed）。
const REPO_PATTERN = /^[^/*]+\/([^/]+|\*)$/;

// ALLOWED_REPOS（カンマ区切り owner/repo または owner/*）を正規化する。
// トリム・空エントリ除外・小文字化・重複除去を行い、形式不正は fail-fast で throw する。
// GitHub の owner/repo は大文字小文字を区別しないため小文字に正規化する。
export function parseAllowlist(raw: string): AllowlistConfig {
  const repos = new Set<string>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    if (!REPO_PATTERN.test(entry)) {
      throw new Error(
        `ALLOWED_REPOS entry must be in 'owner/repo' or 'owner/*' format: '${entry}'`,
      );
    }
    repos.add(entry.toLowerCase());
  }
  return { repos: [...repos] };
}

// allowedRepos が空なら全拒否（fail-closed）。
// エントリが owner/* の場合は owner 内の全 repo を許可する。
export function isAllowed(allowedRepos: readonly string[], owner: string, repo: string): boolean {
  const target = `${owner}/${repo}`.toLowerCase();
  const ownerPrefix = `${owner}/*`.toLowerCase();
  return allowedRepos.some((entry) => entry === target || entry === ownerPrefix);
}

export class RepositoryNotAllowedError extends Error {
  readonly owner: string;
  readonly repo: string;

  constructor(owner: string, repo: string) {
    super(`Repository ${owner}/${repo} is not in the allowlist`);
    this.name = "RepositoryNotAllowedError";
    this.owner = owner;
    this.repo = repo;
  }
}

// write 操作の allowlist ガード。allowlist 外なら RepositoryNotAllowedError を throw（fail-closed）。
export function assertRepoWritable(
  allowedRepos: readonly string[],
  owner: string,
  repo: string,
): void {
  if (!isAllowed(allowedRepos, owner, repo)) {
    throw new RepositoryNotAllowedError(owner, repo);
  }
}
