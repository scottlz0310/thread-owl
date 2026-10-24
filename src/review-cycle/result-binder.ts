import type { Logger } from "../config/logging.js";
import type { GitHubClient } from "../github/client.js";
import { listIssueComments, listPullRequestReviews } from "../github/rest.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import type { PullRequestRef, ReviewRound, ReviewStatusStore } from "../queue/review-status.js";
import { buildMarker, parseMarker } from "./correlation.js";
import { ContractError } from "./errors.js";
import type {
  PendingWrite,
  ResultKind,
  ResultPost,
  ReviewCycleLedger,
  ReviewResult,
} from "./ledger.js";

export interface ResultBinderDeps {
  ledger: ReviewCycleLedger;
  queue: ReviewQueue;
  reviewStatus?: ReviewStatusStore;
  /** 照合のために PR の投稿を読む client（installation token）。 */
  getClient: (owner: string, repo: string) => Promise<GitHubClient>;
  /** thread-owl 自身の投稿者（例: `thread-owl[bot]`）。他者が付けたマーカーは信用しない。 */
  botLogin: string;
  logger: Logger;
  now?: () => Date;
}

export interface BoundPost {
  /** 書込みの結果。GitHub 上の投稿の ID と URL。 */
  id: number;
  url: string;
}

export interface BoundPostRequest {
  candidateId: string;
  pr: PullRequestRef;
  /** 省略可（投稿 tool によっては HEAD を取らない）。指定されたら候補の HEAD と一致しなければならない。 */
  headSha?: string;
  kind: ResultKind;
  /** GitHub へ書く。本文には、渡されたマーカーを付けること。 */
  write: (marker: string) => Promise<BoundPost>;
}

/**
 * reviewer の起動から結果の投稿までを cycle に束縛する。投稿は台帳の「書込み開始 → 記録」で挟み、
 * 本文に相関マーカー（writeId）を付けるので、投稿直後の停止も GitHub 上の投稿で照合して回復できる。
 * 投稿時に「現在の round」を引き直さず、受付時の cycle の同一性を使う。
 */
export class ResultBinder {
  private readonly active = new Set<string>();
  private readonly statusRounds = new Map<string, ReviewRound>();
  private readonly now: () => Date;

  constructor(private readonly deps: ResultBinderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** 受付時（markPending の直後）の status のラウンドを、cycle に結び付けて覚える。 */
  noteStatusRound(cycleId: string, pr: PullRequestRef): void {
    this.statusRounds.set(cycleId, this.deps.reviewStatus?.currentRound(pr));
  }

  async post(request: BoundPostRequest): Promise<ReviewResult> {
    const { ledger, queue } = this.deps;
    // 起動を記録する前に、状態を変えずに検証する（拒否された入力で、候補が未起動でなくならないように）。
    const candidate = ledger.getCandidate(request.candidateId);
    if (!candidate) {
      throw new ContractError("REQUEST_NOT_FOUND", "候補が見つからない");
    }
    if (
      candidate.owner.toLowerCase() !== request.pr.owner.toLowerCase() ||
      candidate.repo.toLowerCase() !== request.pr.repo.toLowerCase() ||
      candidate.prNumber !== request.pr.prNumber
    ) {
      throw new ContractError("INVALID_ARGUMENT", "candidateId の PR と、投稿先の PR が異なる");
    }
    if (request.headSha !== undefined && request.headSha !== candidate.headSha) {
      throw new ContractError(
        "RESULT_HEAD_MISMATCH",
        "投稿の HEAD が、候補の HEAD（cycle に固定された HEAD）と異なる",
      );
    }
    // 検証を通ったので、起動を記録する（取消済みなら CANDIDATE_CANCELLED）。起動した候補は queue から外す。
    const binding = ledger.start(request.candidateId);
    queue.removeCycle(binding.cycleId);

    // 前の書込みが結果不明のまま残っていれば（停止・失敗の後）、投稿の有無を照合してから始める。
    const recovered = await this.reconcileStale(binding.cycleId);
    // 前の書込みが実は成功していた場合、同じ種別の再試行は再投稿せず、その投稿を結果として返す。
    if (recovered && recovered.kind === request.kind) {
      this.markStatus(binding.cycleId, request, recovered.post.commentId, binding.headSha);
      return recovered;
    }

    const begun = ledger.beginResultWrite(request.candidateId, request.kind);
    const marker = buildMarker({
      cycleId: binding.cycleId,
      candidateId: request.candidateId,
      writeId: begun.writeId,
      kind: request.kind,
    });
    this.active.add(request.candidateId);
    let posted: BoundPost;
    try {
      // 失敗しても書込みの進行中は解除しない。投稿の有無が不明なので、次の照合で決める。
      posted = await request.write(marker);
    } finally {
      this.active.delete(request.candidateId);
    }
    const result = ledger.recordResultPosted(request.candidateId, {
      writeId: begun.writeId,
      kind: request.kind,
      headSha: binding.headSha,
      post: { commentId: posted.id, url: posted.url },
      postedAt: this.now().toISOString(),
    });
    this.markStatus(binding.cycleId, request, posted.id, binding.headSha);
    return result;
  }

  /**
   * このプロセスが書いていない「進行中の書込み」（停止後の再起動・失敗した書込み）を、GitHub 上の投稿で照合して
   * 台帳に反映する。見つかれば結果として記録し、無ければ書込みを解除する。照合できなければ例外のまま伝播し、
   * 書込みは進行中のまま残る（取消も確定しない）。見つけた投稿を記録した場合は、その結果を返す。
   */
  async reconcileStale(cycleId: string): Promise<ReviewResult | undefined> {
    const pending = this.deps.ledger.pendingWriteByCycle(cycleId);
    if (!pending || this.active.has(pending.candidateId)) {
      return undefined;
    }
    const found = await this.findPost(pending);
    if (found) {
      const recorded = this.deps.ledger.recordResultPosted(pending.candidateId, {
        writeId: pending.writeId,
        kind: pending.kind,
        headSha: pending.headSha,
        post: found.post,
        postedAt: found.postedAt,
      });
      this.deps.logger.info("internal.result.reconciled", {
        event: "internal.result.reconciled",
        cycleId,
        outcome: "posted",
      });
      return recorded;
    }
    this.deps.ledger.abortResultWrite(pending.candidateId, pending.writeId);
    this.deps.logger.info("internal.result.reconciled", {
      event: "internal.result.reconciled",
      cycleId,
      outcome: "not_posted",
    });
    return undefined;
  }

  private async findPost(pending: PendingWrite): Promise<ResultPost | undefined> {
    const client = await this.deps.getClient(pending.owner, pending.repo);
    const base = `https://github.com/${pending.owner}/${pending.repo}/pull/${pending.prNumber}`;
    const items =
      pending.kind === "approved"
        ? await listPullRequestReviews(client, pending.owner, pending.repo, pending.prNumber)
        : await listIssueComments(client, pending.owner, pending.repo, pending.prNumber);
    const fragment = pending.kind === "approved" ? "pullrequestreview" : "issuecomment";
    const bot = this.deps.botLogin.toLowerCase();
    const match = items
      .filter((item) => item.authorLogin?.toLowerCase() === bot)
      .sort((a, b) => a.id - b.id)
      .find((item) => {
        const marker = parseMarker(item.body);
        return (
          marker?.writeId === pending.writeId &&
          marker.candidateId === pending.candidateId &&
          marker.cycleId === pending.cycleId &&
          marker.kind === pending.kind
        );
      });
    if (!match) {
      return undefined;
    }
    return {
      kind: pending.kind,
      headSha: pending.headSha,
      post: { commentId: match.id, url: `${base}#${fragment}-${match.id}` },
      postedAt: match.createdAt,
    };
  }

  private markStatus(
    cycleId: string,
    request: BoundPostRequest,
    postId: number,
    headSha: string,
  ): void {
    const { reviewStatus } = this.deps;
    if (!reviewStatus) {
      return;
    }
    const round = this.statusRounds.get(cycleId);
    if (request.kind === "approved") {
      reviewStatus.markApproved(request.pr, { headSha, round });
    } else {
      reviewStatus.markReviewed(request.pr, { summaryCommentId: postId, headSha, round });
    }
  }
}
