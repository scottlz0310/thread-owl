// Resolve GitHub App installation_id from owner/repo

import { Octokit } from "@octokit/rest";

interface RepoInstallationClient {
  rest: {
    apps: {
      getRepoInstallation(options: { owner: string; repo: string }): Promise<{
        data: { id: number };
      }>;
    };
  };
}

export interface ResolveInstallationIdOptions {
  client?: RepoInstallationClient;
}

export class InstallationNotFoundError extends Error {
  readonly status = 404;
  readonly owner: string;
  readonly repo: string;

  constructor(owner: string, repo: string, options: ErrorOptions = {}) {
    super(`GitHub App installation was not found for ${owner}/${repo}`, options);
    this.name = "InstallationNotFoundError";
    this.owner = owner;
    this.repo = repo;
  }
}

export async function resolveInstallationId(
  appJwt: string,
  owner: string,
  repo: string,
  options: ResolveInstallationIdOptions = {},
): Promise<number> {
  const client = options.client ?? new Octokit({ auth: appJwt });

  try {
    const response = await client.rest.apps.getRepoInstallation({ owner, repo });

    return response.data.id;
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new InstallationNotFoundError(owner, repo, { cause: error });
    }

    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}
