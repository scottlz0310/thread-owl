import type { Logger } from "../../config/logging.js";
import { isAllowed } from "../../policy/allowlist.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface IssueCommentHandlerDeps {
  logger: Logger;
  allowedRepos: readonly string[];
}

export async function handleIssueCommentEvent(
  event: NormalizedEvent,
  deps: IssueCommentHandlerDeps,
): Promise<void> {
  const { owner, repo } = event;

  if (!isRecord(event.payload)) return;
  const { action, issue } = event.payload;

  if (action !== "created") return;

  if (!isRecord(issue)) return;

  // PR に紐づかない issue comment は無視する
  if (!isRecord(issue.pull_request)) return;

  if (!isAllowed(deps.allowedRepos, owner, repo)) {
    deps.logger.debug("webhook.issue_comment.allowlist.rejected", {
      event: "webhook.issue_comment.allowlist.rejected",
      owner,
      repo,
    });
    return;
  }

  deps.logger.info("webhook.issue_comment.received", {
    event: "webhook.issue_comment.received",
    owner,
    repo,
    prNumber: event.prNumber,
  });
}
