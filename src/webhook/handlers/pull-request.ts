import type { Logger } from "../../config/logging.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";

export interface PullRequestHandlerDeps {
  queue: ReviewQueue;
  logger: Logger;
}

export async function handlePullRequestEvent(
  _event: NormalizedEvent,
  _deps: PullRequestHandlerDeps,
): Promise<void> {
  // implemented in #46
}
