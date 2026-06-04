// Per-repository operation policy

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

export async function loadRepositoryPolicy(
  _owner: string,
  _repo: string,
): Promise<RepositoryPolicy> {
  throw new Error("not implemented");
}
