import type { Logger } from "../../config/logging.js";
import { isAllowed } from "../../policy/allowlist.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface PullRequestReviewHandlerDeps {
  logger: Logger;
  allowedRepos: readonly string[];
}

export async function handlePullRequestReviewEvent(
  event: NormalizedEvent,
  deps: PullRequestReviewHandlerDeps,
): Promise<void> {
  const { owner, repo } = event;

  if (!isRecord(event.payload)) return;
  const { action } = event.payload;

  if (action !== "submitted") return;

  if (!isAllowed(deps.allowedRepos, owner, repo)) {
    deps.logger.debug("webhook.pull_request_review.allowlist.rejected", {
      event: "webhook.pull_request_review.allowlist.rejected",
      owner,
      repo,
    });
    return;
  }

  deps.logger.info("webhook.pull_request_review.received", {
    event: "webhook.pull_request_review.received",
    owner,
    repo,
    prNumber: event.prNumber,
  });
}
