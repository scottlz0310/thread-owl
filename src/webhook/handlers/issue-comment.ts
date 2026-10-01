import type { Logger } from "../../config/logging.js";
import type { PullRequest } from "../../github/pull-requests.js";
import { isAllowed } from "../../policy/allowlist.js";
import {
  evaluatePullRequestOrigin,
  isAuthorAllowed,
  isAuthorCheckEnabled,
  type OriginRejectionReason,
} from "../../policy/author-policy.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { isRecord } from "../utils.js";

export interface IssueCommentHandlerDeps {
  queue: ReviewQueue;
  logger: Logger;
  allowedRepos: readonly string[];
  // PR の作成者 allowlist（正規化済みの login）。空の間は投稿者・作成者・fork を検証しない。
  allowedAuthors: readonly string[];
  // 検証が有効なときだけ呼ぶ。取得に失敗したら例外のまま伝播し、enqueue しない（fail-closed）。
  getPullRequest: (owner: string, repo: string, prNumber: number) => Promise<PullRequest>;
  appSlug: string;
}

export type CommenterRejection = "commenter_unknown" | "commenter_not_allowed";

export type CommentOriginRejection = CommenterRejection | OriginRejectionReason;

// 再レビュー依頼のコメントの投稿者を検証する。検証が無効（allowlist が空）なら許可する。
export function evaluateCommenter(
  allowedAuthors: readonly string[],
  commenterLogin: string | null,
): CommenterRejection | null {
  if (!isAuthorCheckEnabled(allowedAuthors)) return null;
  if (commenterLogin === null) return "commenter_unknown";
  if (!isAuthorAllowed(allowedAuthors, commenterLogin)) return "commenter_not_allowed";
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

  // 許可された投稿者が、他者の PR や fork の PR への再レビューを依頼して queue に載せることを防ぐ。
  // payload に head の repository が無いため、PR を取得して作成者と fork を照合する。
  if (isAuthorCheckEnabled(deps.allowedAuthors)) {
    const commenterLogin = requestedBy ?? null;
    const commenterRejection = evaluateCommenter(deps.allowedAuthors, commenterLogin);
    let rejection: CommentOriginRejection | null = commenterRejection;
    let prAuthorLogin: string | null | undefined;
    if (commenterRejection === null) {
      const pr = await deps.getPullRequest(owner, repo, prNumber);
      prAuthorLogin = pr.author?.login ?? null;
      const decision = evaluatePullRequestOrigin(deps.allowedAuthors, {
        authorLogin: prAuthorLogin,
        fork: pr.head.repo === null ? null : pr.head.repo.fork,
      });
      rejection = decision.allowed ? null : decision.reason;
    }
    if (rejection !== null) {
      // 拒否は監査ログに残す。login は記録するが、コメント本文は記録しない。
      // prAuthorLogin は、PR を取得した場合だけ記録する。
      deps.logger.info("webhook.issue_comment.origin.rejected", {
        event: "webhook.issue_comment.origin.rejected",
        owner,
        repo,
        prNumber,
        reason: rejection,
        commenterLogin,
        ...(prAuthorLogin === undefined ? {} : { prAuthorLogin }),
      });
      return;
    }
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
