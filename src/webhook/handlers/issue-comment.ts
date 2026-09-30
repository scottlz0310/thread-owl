import type { Logger } from "../../config/logging.js";
import { isAllowed } from "../../policy/allowlist.js";
import { isAuthorAllowed, isAuthorCheckEnabled } from "../../policy/author-policy.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface IssueCommentHandlerDeps {
  queue: ReviewQueue;
  logger: Logger;
  allowedRepos: readonly string[];
  // PR の作成者 allowlist（正規化済みの login）。空の間は投稿者・作成者を検証しない。
  allowedAuthors: readonly string[];
  appSlug: string;
}

export type CommentOriginRejection =
  | "commenter_unknown"
  | "commenter_not_allowed"
  | "pr_author_unknown"
  | "pr_author_not_allowed";

// 再レビュー依頼のコメントは、投稿者と PR の作成者の両方が許可されている場合だけ受け付ける。
// 許可された投稿者が、他者の PR への再レビューを依頼して queue に載せることを防ぐ。
// issue_comment の payload に head の repository は無いため、fork は検証できない
// （fork の検出は、PR の webhook、enqueue_review、get_pr の head.repo で行う）。
export function evaluateCommentOrigin(
  allowedAuthors: readonly string[],
  commenterLogin: string | null,
  prAuthorLogin: string | null,
): CommentOriginRejection | null {
  if (!isAuthorCheckEnabled(allowedAuthors)) return null;
  if (commenterLogin === null) return "commenter_unknown";
  if (!isAuthorAllowed(allowedAuthors, commenterLogin)) return "commenter_not_allowed";
  if (prAuthorLogin === null) return "pr_author_unknown";
  if (!isAuthorAllowed(allowedAuthors, prAuthorLogin)) return "pr_author_not_allowed";
  return null;
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

  const prAuthorLogin =
    isRecord(issue.user) && typeof issue.user.login === "string" ? issue.user.login : null;
  const rejection = evaluateCommentOrigin(deps.allowedAuthors, requestedBy ?? null, prAuthorLogin);
  if (rejection !== null) {
    // 拒否は監査ログに残す。login は記録するが、コメント本文は記録しない。
    deps.logger.info("webhook.issue_comment.origin.rejected", {
      event: "webhook.issue_comment.origin.rejected",
      owner,
      repo,
      prNumber,
      reason: rejection,
      commenterLogin: requestedBy ?? null,
      prAuthorLogin,
    });
    return;
  }

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
