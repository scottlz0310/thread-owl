// pull_request_review_comment webhook event handler

import type { NormalizedEvent } from "../normalize-event.js";

export async function handlePullRequestReviewCommentEvent(_event: NormalizedEvent): Promise<void> {
  throw new Error("not implemented");
}
