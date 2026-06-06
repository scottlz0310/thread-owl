import type { Logger } from "../../config/logging.js";
import type { NormalizedEvent } from "../normalize-event.js";

export interface IssueCommentHandlerDeps {
  logger: Logger;
}

export async function handleIssueCommentEvent(
  _event: NormalizedEvent,
  _deps: IssueCommentHandlerDeps,
): Promise<void> {
  // implemented in #48
}
