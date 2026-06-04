// issue_comment webhook event handler

import type { NormalizedEvent } from "../normalize-event.js";

export async function handleIssueCommentEvent(_event: NormalizedEvent): Promise<void> {
  throw new Error("not implemented");
}
