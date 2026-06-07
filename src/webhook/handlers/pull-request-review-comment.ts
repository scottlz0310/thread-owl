import type { Logger } from "../../config/logging.js";
import { isAllowed } from "../../policy/allowlist.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface PullRequestReviewCommentHandlerDeps {
  logger: Logger;
  allowedRepos: readonly string[];
}

export async function handlePullRequestReviewCommentEvent(
  event: NormalizedEvent,
  deps: PullRequestReviewCommentHandlerDeps,
): Promise<void> {
  const { owner, repo } = event;

  if (!isRecord(event.payload)) return;
  const { action } = event.payload;

  if (action !== "created") return;

  if (!isAllowed(deps.allowedRepos, owner, repo)) {
    deps.logger.debug("webhook.pull_request_review_comment.allowlist.rejected", {
      event: "webhook.pull_request_review_comment.allowlist.rejected",
      owner,
      repo,
    });
    return;
  }

  deps.logger.info("webhook.pull_request_review_comment.received", {
    event: "webhook.pull_request_review_comment.received",
    owner,
    repo,
    prNumber: event.prNumber,
  });
}
