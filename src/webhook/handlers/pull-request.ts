import type { Logger } from "../../config/logging.js";
import { isAllowed } from "../../policy/allowlist.js";
import {
  evaluatePullRequestOrigin,
  isAuthorCheckEnabled,
  type PullRequestOrigin,
} from "../../policy/author-policy.js";
import type { ReviewCandidate, ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface PullRequestHandlerDeps {
  queue: ReviewQueue;
  logger: Logger;
  allowedRepos: readonly string[];
  // PR の作成者 allowlist（正規化済みの login）。空の間は作成者・fork を検証しない。
  allowedAuthors: readonly string[];
}

// payload から作成者と head の repository を取り出す。読めないものは null（検証が有効なら拒否される）。
function readOrigin(pr: Record<string, unknown>, owner: string, repo: string): PullRequestOrigin {
  const authorLogin = isRecord(pr.user) && typeof pr.user.login === "string" ? pr.user.login : null;
  const headRepo = isRecord(pr.head) && isRecord(pr.head.repo) ? pr.head.repo : null;
  const headFullName =
    headRepo !== null && typeof headRepo.full_name === "string" ? headRepo.full_name : null;
  return {
    authorLogin,
    fork:
      headFullName === null
        ? null
        : headFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase(),
  };
}

const HANDLED_ACTIONS = new Set(["opened", "synchronize", "ready_for_review"]);

function reasonFor(action: string): ReviewCandidate["reason"] {
  return action === "synchronize" ? "synchronized" : "opened";
}

export async function handlePullRequestEvent(
  event: NormalizedEvent,
  deps: PullRequestHandlerDeps,
): Promise<void> {
  const { owner, repo, installationId, prNumber } = event;

  if (!isRecord(event.payload)) return;
  const { action, pull_request: pr } = event.payload;

  if (typeof action !== "string" || !HANDLED_ACTIONS.has(action)) return;

  if (!isRecord(pr)) return;

  // draft PR はスキップ。ready_for_review は draft=false に変わった直後なので通過させる。
  if (pr.draft === true && action !== "ready_for_review") {
    deps.logger.debug("webhook.pull_request.draft.skipped", {
      event: "webhook.pull_request.draft.skipped",
      owner,
      repo,
      prNumber,
    });
    return;
  }

  if (!isAllowed(deps.allowedRepos, owner, repo)) {
    deps.logger.debug("webhook.pull_request.allowlist.rejected", {
      event: "webhook.pull_request.allowlist.rejected",
      owner,
      repo,
    });
    return;
  }

  if (prNumber === undefined) return;

  // 作成者・fork の検証が有効なときは、許可されない PR を queue に載せない。
  if (isAuthorCheckEnabled(deps.allowedAuthors)) {
    const origin = readOrigin(pr, owner, repo);
    const decision = evaluatePullRequestOrigin(deps.allowedAuthors, origin);
    if (!decision.allowed) {
      // 拒否は監査ログに残す。作成者の login は記録するが、本文は記録しない。
      deps.logger.info("webhook.pull_request.origin.rejected", {
        event: "webhook.pull_request.origin.rejected",
        owner,
        repo,
        prNumber,
        reason: decision.reason,
        authorLogin: origin.authorLogin,
      });
      return;
    }
  }

  deps.queue.enqueue({
    owner,
    repo,
    prNumber,
    installationId,
    queuedAt: new Date(),
    reason: reasonFor(action),
  });

  deps.logger.info("webhook.pull_request.queued", {
    event: "webhook.pull_request.queued",
    owner,
    repo,
    prNumber,
    action,
    reason: reasonFor(action),
  });
}
