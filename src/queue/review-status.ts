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

export interface ReviewStatusStore {
  /** 過去ラウンドの完了状態で購読側が即時誤検知しないよう、状態を初期化する。listener は呼ばない。 */
  markPending(pr: PullRequestRef): void;
  markReviewed(pr: PullRequestRef, update: { summaryCommentId: number; headSha?: string }): void;
  markApproved(pr: PullRequestRef, update: { headSha: string }): void;
  get(pr: PullRequestRef): ReviewStatus | undefined;
  list(): ReviewStatus[];
  /** reviewed / approved の記録時に呼ばれる listener を登録する。戻り値は解除関数。 */
  onUpdated(listener: (status: ReviewStatus) => void): () => void;
}

export function createReviewStatusStore(): ReviewStatusStore {
  // Map の挿入順を更新順として使い、上限超過時は最も古く更新された PR から捨てる。
  const items = new Map<string, ReviewStatus>();
  const listeners = new Set<(status: ReviewStatus) => void>();

  // owner/repo は大文字小文字を区別しない（ReviewQueue の dedup key と同様）。
  function prKey(pr: PullRequestRef): string {
    return `${pr.owner}/${pr.repo}#${pr.prNumber}`.toLowerCase();
  }

  function save(status: ReviewStatus): void {
    const key = prKey(status);
    items.delete(key);
    if (items.size >= MAX_TRACKED_PULL_REQUESTS) {
      const oldest = items.keys().next().value;
      if (oldest !== undefined) items.delete(oldest);
    }
    items.set(key, status);
  }

  function notify(status: ReviewStatus): void {
    for (const listener of listeners) {
      listener(status);
    }
  }

  return {
    markPending({ owner, repo, prNumber }) {
      save({
        owner,
        repo,
        prNumber,
        headSha: null,
        status: "pending",
        summaryCommentId: null,
        updatedAt: new Date(),
      });
    },
    markReviewed({ owner, repo, prNumber }, { summaryCommentId, headSha }) {
      const status: ReviewStatus = {
        owner,
        repo,
        prNumber,
        headSha: headSha ?? null,
        status: "reviewed",
        summaryCommentId,
        updatedAt: new Date(),
      };
      save(status);
      notify(status);
    },
    markApproved(pr, { headSha }) {
      const status: ReviewStatus = {
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.prNumber,
        headSha,
        status: "approved",
        // 同一ラウンドで投稿済みのサマリーコメントは approve 後も参照できるよう引き継ぐ。
        summaryCommentId: items.get(prKey(pr))?.summaryCommentId ?? null,
        updatedAt: new Date(),
      };
      save(status);
      notify(status);
    },
    get(pr) {
      return items.get(prKey(pr));
    },
    list() {
      return [...items.values()];
    },
    onUpdated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
