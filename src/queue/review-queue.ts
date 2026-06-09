const MAX_QUEUE_SIZE = 100;

export interface ReviewCandidate {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  queuedAt: Date;
  reason: "opened" | "synchronized" | "re-review-requested";
  // re-review-requested のとき付与
  sourceCommentId?: number;
  requestedBy?: string;
}

export interface ReviewQueue {
  enqueue(candidate: ReviewCandidate): void;
  dequeue(): ReviewCandidate | undefined;
  list(): ReviewCandidate[];
  size(): number;
  /** enqueue 時に呼ばれる listener を登録する。戻り値は解除関数。 */
  onEnqueue(listener: () => void): () => void;
}

export function createReviewQueue(): ReviewQueue {
  const items: ReviewCandidate[] = [];
  const listeners = new Set<() => void>();

  function prKey(c: ReviewCandidate): string {
    return `${c.owner}/${c.repo}#${c.prNumber}`;
  }

  return {
    enqueue(candidate: ReviewCandidate): void {
      const key = prKey(candidate);
      const existing = items.findIndex((item) => prKey(item) === key);
      // dedup を先に行うことで、同一 PR の再エンキューは上限カウントに影響しない。
      // 順序を逆にすると、満杯時に同一 PR を再エンキューすると無関係な最古エントリが誤って削除される。
      if (existing !== -1) {
        // re-review-requested は synchronized / opened より優先する。
        // 修正 push のタイミングで先着の re-review-requested が上書きされないよう保護する。
        if (
          items[existing].reason === "re-review-requested" &&
          candidate.reason !== "re-review-requested"
        ) {
          return;
        }
        items.splice(existing, 1);
      }
      if (items.length >= MAX_QUEUE_SIZE) {
        items.shift();
      }
      items.push(candidate);
      // synchronized は queue を更新するが subscriber への通知は行わない。
      // review の起動は opened / re-review-requested の明示的イベントのみが担う。
      // これにより push-first 順序（synchronized → re-review-requested）でも
      // subscriber が受け取る最初の通知は必ず re-review-requested になる。
      if (candidate.reason !== "synchronized") {
        for (const listener of listeners) {
          listener();
        }
      }
    },
    dequeue(): ReviewCandidate | undefined {
      return items.shift();
    },
    list(): ReviewCandidate[] {
      return [...items];
    },
    size(): number {
      return items.length;
    },
    onEnqueue(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
