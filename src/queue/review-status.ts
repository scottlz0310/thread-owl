const MAX_TRACKED_PULL_REQUESTS = 100;

export interface PullRequestRef {
  owner: string;
  repo: string;
  prNumber: number;
}

export interface ReviewStatus extends PullRequestRef {
  headSha: string | null;
  status: "pending" | "reviewed" | "approved";
  summaryCommentId: number | null;
  updatedAt: Date;
}

/** markPending ごとに払い出すラウンド識別子。一度も pending にしていない PR は undefined。 */
export type ReviewRound = number | undefined;

export interface ReviewStatusStore {
  /** 過去ラウンドの完了状態で購読側が即時誤検知しないよう、新しいラウンドとして初期化する。listener は呼ばない。 */
  markPending(pr: PullRequestRef): void;
  /** 完了更新の対象ラウンドを、GitHub への書き込み開始前に捕捉するために使う。 */
  currentRound(pr: PullRequestRef): ReviewRound;
  /** round が現在のラウンドと異なる（途中で markPending された）場合は更新せず false を返す。 */
  markReviewed(
    pr: PullRequestRef,
    update: { summaryCommentId: number; headSha?: string; round: ReviewRound },
  ): boolean;
  /** round が現在のラウンドと異なる（途中で markPending された）場合は更新せず false を返す。 */
  markApproved(pr: PullRequestRef, update: { headSha: string; round: ReviewRound }): boolean;
  get(pr: PullRequestRef): ReviewStatus | undefined;
  list(): ReviewStatus[];
  /** reviewed / approved の記録時に呼ばれる listener を登録する。戻り値は解除関数。 */
  onUpdated(listener: (status: ReviewStatus) => void): () => void;
}

interface Entry {
  status: ReviewStatus;
  round: ReviewRound;
}

export function createReviewStatusStore(): ReviewStatusStore {
  // Map の挿入順を更新順として使い、上限超過時は最も古く更新された PR から捨てる。
  const items = new Map<string, Entry>();
  const listeners = new Set<(status: ReviewStatus) => void>();
  // 破棄後に同じ PR が再登録されても過去の値と衝突しないよう、PR 単位ではなく store 全体で単調増加させる。
  let lastRound = 0;

  // owner/repo は大文字小文字を区別しない（ReviewQueue の dedup key と同様）。
  function prKey(pr: PullRequestRef): string {
    return `${pr.owner}/${pr.repo}#${pr.prNumber}`.toLowerCase();
  }

  function save(entry: Entry): void {
    const key = prKey(entry.status);
    items.delete(key);
    if (items.size >= MAX_TRACKED_PULL_REQUESTS) {
      const oldest = items.keys().next().value;
      if (oldest !== undefined) items.delete(oldest);
    }
    items.set(key, entry);
  }

  function complete(entry: Entry): void {
    save(entry);
    for (const listener of listeners) {
      listener(entry.status);
    }
  }

  return {
    markPending({ owner, repo, prNumber }) {
      lastRound += 1;
      save({
        status: {
          owner,
          repo,
          prNumber,
          headSha: null,
          status: "pending",
          summaryCommentId: null,
          updatedAt: new Date(),
        },
        round: lastRound,
      });
    },
    currentRound(pr) {
      return items.get(prKey(pr))?.round;
    },
    markReviewed({ owner, repo, prNumber }, { summaryCommentId, headSha, round }) {
      if (items.get(prKey({ owner, repo, prNumber }))?.round !== round) return false;
      complete({
        status: {
          owner,
          repo,
          prNumber,
          headSha: headSha ?? null,
          status: "reviewed",
          summaryCommentId,
          updatedAt: new Date(),
        },
        round,
      });
      return true;
    },
    markApproved(pr, { headSha, round }) {
      const current = items.get(prKey(pr));
      if (current?.round !== round) return false;
      complete({
        status: {
          owner: pr.owner,
          repo: pr.repo,
          prNumber: pr.prNumber,
          headSha,
          status: "approved",
          // 同一ラウンドで投稿済みのサマリーコメントは approve 後も参照できるよう引き継ぐ。
          summaryCommentId: current?.status.summaryCommentId ?? null,
          updatedAt: new Date(),
        },
        round,
      });
      return true;
    },
    get(pr) {
      return items.get(prKey(pr))?.status;
    },
    list() {
      return [...items.values()].map((entry) => entry.status);
    },
    onUpdated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
