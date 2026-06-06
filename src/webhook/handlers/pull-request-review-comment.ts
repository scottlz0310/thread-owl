import type { Logger } from "../../config/logging.js";
import type { NormalizedEvent } from "../normalize-event.js";

export interface PullRequestReviewCommentHandlerDeps {
  logger: Logger;
}

export async function handlePullRequestReviewCommentEvent(
  _event: NormalizedEvent,
  _deps: PullRequestReviewCommentHandlerDeps,
): Promise<void> {
  // implemented in #48
}
