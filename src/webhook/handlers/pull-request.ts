// pull_request webhook event handler

import type { NormalizedEvent } from "../normalize-event.js";

export async function handlePullRequestEvent(_event: NormalizedEvent): Promise<void> {
  throw new Error("not implemented");
}
