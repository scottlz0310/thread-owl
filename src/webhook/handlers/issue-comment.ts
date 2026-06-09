import type { Logger } from "../../config/logging.js";
import { isAllowed } from "../../policy/allowlist.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface IssueCommentHandlerDeps {
  queue: ReviewQueue;
  logger: Logger;
  allowedRepos: readonly string[];
  appSlug: string;
}

// @<appSlug> mention と re-review intent の両方を含むか判定する。
// 大文字小文字は区別しない。`再レビュー` は日本語のため変換不要。
export function detectReReviewMention(body: string, appSlug: string): boolean {
  const lower = body.toLowerCase();
  if (!lower.includes(`@${appSlug.toLowerCase()}`)) return false;
  return (
    lower.includes("re-review") ||
    lower.includes("rereview") ||
    lower.includes("review again") ||
    lower.includes("再レビュー")
  );
}

export async function handleIssueCommentEvent(
  event: NormalizedEvent,
  deps: IssueCommentHandlerDeps,
): Promise<void> {
  const { owner, repo, installationId, prNumber } = event;

  if (!isRecord(event.payload)) return;
  const { action, issue, comment } = event.payload;

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

  if (prNumber === undefined) return;
  if (!isRecord(comment) || typeof comment.body !== "string") return;

  if (!detectReReviewMention(comment.body, deps.appSlug)) {
    deps.logger.debug("webhook.issue_comment.no_rereview_intent", {
      event: "webhook.issue_comment.no_rereview_intent",
      owner,
      repo,
      prNumber,
    });
    return;
  }

  const sourceCommentId = typeof comment.id === "number" ? comment.id : undefined;
  const requestedBy =
    isRecord(comment.user) && typeof comment.user.login === "string"
      ? comment.user.login
      : undefined;

  deps.queue.enqueue({
    owner,
    repo,
    prNumber,
    installationId,
    queuedAt: new Date(),
    reason: "re-review-requested",
    sourceCommentId,
    requestedBy,
  });

  deps.logger.info("webhook.issue_comment.re_review_queued", {
    event: "webhook.issue_comment.re_review_queued",
    owner,
    repo,
    prNumber,
    sourceCommentId,
    requestedBy,
  });
}
