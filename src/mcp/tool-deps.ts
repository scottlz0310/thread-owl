// Shared dependencies for MCP tools

import type { GitHubClient } from "../github/client.js";
import { createClient } from "../github/client.js";
import type { WriteContext } from "../github/write-context.js";
import { type IssueTokenDeps, issueToken } from "../internal-api/token-source.js";

export interface ToolDeps {
  getClient: (owner: string, repo: string) => Promise<GitHubClient>;
  getWriteContext: (owner: string, repo: string) => Promise<WriteContext>;
}

// 各 tool は owner/repo から installation token を都度発行し、認証済み client を得る。
// allowlist ゲートは issueToken（token 発行）時に効くため、allowlist 外 repo は read/write とも拒否される。
export function buildToolDeps(deps: IssueTokenDeps): ToolDeps {
  const getClient = async (owner: string, repo: string): Promise<GitHubClient> => {
    const { token } = await issueToken({ owner, repo }, deps);
    return createClient(token);
  };
  return {
    getClient,
    getWriteContext: async (owner, repo) => ({
      client: await getClient(owner, repo),
      allowedRepos: deps.config.policy.allowedRepos,
      logger: deps.logger,
    }),
  };
}
