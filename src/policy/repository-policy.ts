// Per-repository operation policy

import { isAllowed } from "./allowlist.js";

export interface RepositoryPolicy {
  owner: string;
  repo: string;
  allowInlineComments: boolean;
  allowSummaryComments: boolean;
  allowResolve: boolean;
  requireHumanApproval: boolean;
}

export function getDefaultPolicy(owner: string, repo: string): RepositoryPolicy {
  return {
    owner,
    repo,
    allowInlineComments: true,
    allowSummaryComments: true,
    allowResolve: true,
    requireHumanApproval: false,
  };
}

export function getReadOnlyPolicy(owner: string, repo: string): RepositoryPolicy {
  return {
    owner,
    repo,
    allowInlineComments: false,
    allowSummaryComments: false,
    allowResolve: false,
    requireHumanApproval: false,
  };
}

// allowlist に含まれれば write 操作を許可し、含まれなければ read-only にする（fail-closed）。
export function resolveRepositoryPolicy(
  allowedRepos: readonly string[],
  owner: string,
  repo: string,
): RepositoryPolicy {
  return isAllowed(allowedRepos, owner, repo)
    ? getDefaultPolicy(owner, repo)
    : getReadOnlyPolicy(owner, repo);
}
