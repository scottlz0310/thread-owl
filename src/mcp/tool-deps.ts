// Shared dependencies for MCP tools

import type { Logger } from "../config/logging.js";
import type { GitHubClient } from "../github/client.js";
import { createClient } from "../github/client.js";
import type { WriteContext } from "../github/write-context.js";
import { type IssueTokenDeps, issueToken, type TokenAccess } from "../internal-api/token-source.js";
import type { ResultBinder } from "../review-cycle/result-binder.js";

export interface ToolDeps {
  getClient: (owner: string, repo: string) => Promise<GitHubClient>;
  getWriteContext: (owner: string, repo: string) => Promise<WriteContext>;
  allowedRepos: readonly string[];
  // PR の作成者 allowlist（正規化済みの login）。空の間は、すべて拒否する（fail-closed）。
  allowedAuthors: readonly string[];
  // PR のコメントの本文を読んでよい投稿者（正規化済みの login）。空の間は、read_pr_comments が止まる（fail-closed）。
  trustedCommentAuthors: readonly string[];
  logger: Logger;
  resolveInstallationId: (owner: string, repo: string) => Promise<number>;
  // 内部面（review-raven との連携）を有効にしたときだけ渡る。投稿 tool の candidateId の束縛に使う。
  resultBinder?: ResultBinder;
}

// 各 tool は owner/repo から installation token を都度発行し、認証済み client を得る。
// read は GitHub App installation の repo scope に委ね、write は allowlist を token 発行前に要求する。
export function buildToolDeps(deps: IssueTokenDeps): ToolDeps {
  const createTokenClient = async (
    owner: string,
    repo: string,
    access: TokenAccess,
  ): Promise<GitHubClient> => {
    const { token } = await issueToken({ owner, repo }, deps, { access });
    return createClient(token);
  };
  const getClient = (owner: string, repo: string): Promise<GitHubClient> =>
    createTokenClient(owner, repo, "read");
  return {
    getClient,
    getWriteContext: async (owner, repo) => ({
      client: await createTokenClient(owner, repo, "write"),
      allowedRepos: deps.config.policy.allowedRepos,
      logger: deps.logger,
    }),
    allowedRepos: deps.config.policy.allowedRepos,
    allowedAuthors: deps.config.policy.allowedAuthors,
    trustedCommentAuthors: deps.config.policy.trustedCommentAuthors,
    logger: deps.logger,
    resolveInstallationId: async (owner: string, repo: string): Promise<number> => {
      const jwt = await deps.generateAppJwt({
        appId: deps.config.github.appId,
        privateKey: deps.config.github.privateKey,
      });
      return deps.resolveInstallationId(jwt.token, owner, repo);
    },
  };
}
