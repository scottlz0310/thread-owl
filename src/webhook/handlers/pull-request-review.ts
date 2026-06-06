import type { Logger } from "../../config/logging.js";
import type { NormalizedEvent } from "../normalize-event.js";

export interface PullRequestReviewHandlerDeps {
  logger: Logger;
}

export async function handlePullRequestReviewEvent(
  _event: NormalizedEvent,
  _deps: PullRequestReviewHandlerDeps,
): Promise<void> {
  // implemented in #48
}
