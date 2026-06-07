import type { Logger } from "../../config/logging.js";
import { isAllowed } from "../../policy/allowlist.js";
import type { ReviewCandidate, ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface PullRequestHandlerDeps {
  queue: ReviewQueue;
  logger: Logger;
  allowedRepos: readonly string[];
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
