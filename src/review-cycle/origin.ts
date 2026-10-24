import type { Logger } from "../config/logging.js";
import type { GitHubClient } from "../github/client.js";
import { getPR } from "../github/pull-requests.js";
import { isAllowed } from "../policy/allowlist.js";
import { evaluatePullRequestOrigin, pullRequestOrigin } from "../policy/author-policy.js";

export type OriginCheck = { allowed: true } | { allowed: false; reason: string };

/** 候補の PR が、reviewer として受け付けてよいものか（repo の allowlist、作成者、fork）を判定する。 */
export type OriginChecker = (owner: string, repo: string, prNumber: number) => Promise<OriginCheck>;

export interface OriginCheckerDeps {
  getClient: (owner: string, repo: string) => Promise<GitHubClient>;
  allowedRepos: readonly string[];
  allowedAuthors: readonly string[];
  logger: Logger;
}

/**
 * enqueue_review と同じ規則で判定する。作成者は自己申告ではなく GitHub API の PR から読む。
 * PR を取得できないときは例外のまま伝播し、受け付けない（fail-closed）。
 */
export function createOriginChecker(
  deps: OriginCheckerDeps,
  fetchPullRequest: typeof getPR = getPR,
): OriginChecker {
  return async (owner, repo, prNumber) => {
    if (!isAllowed(deps.allowedRepos, owner, repo)) {
      return { allowed: false, reason: "repository_not_allowed" };
    }
    // 作成者の allowlist が空なら、どの作成者も許可されないため、PR を取得しない。
    const origin =
      deps.allowedAuthors.length === 0
        ? { authorLogin: null, fork: null }
        : pullRequestOrigin(
            await fetchPullRequest(await deps.getClient(owner, repo), owner, repo, prNumber),
          );
    const decision = evaluatePullRequestOrigin(deps.allowedAuthors, origin);
    if (!decision.allowed) {
      // 拒否は監査ログに残す。作成者の login は記録するが、本文は記録しない。
      deps.logger.warn("internal.accept_review_candidate.origin.rejected", {
        event: "internal.accept_review_candidate.origin.rejected",
        owner,
        repo,
        prNumber,
        reason: decision.reason,
        authorLogin: origin.authorLogin,
      });
      return { allowed: false, reason: decision.reason };
    }
    return { allowed: true };
  };
}
