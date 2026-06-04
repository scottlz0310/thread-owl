// pull_request_review webhook event handler

import type { NormalizedEvent } from "../normalize-event.js";

export async function handlePullRequestReviewEvent(_event: NormalizedEvent): Promise<void> {
  throw new Error("not implemented");
}
