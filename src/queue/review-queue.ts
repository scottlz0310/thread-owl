const MAX_QUEUE_SIZE = 100;

export interface ReviewCandidate {
  owner: string;
  repo: string;
  prNumber: number;
  installationId: number;
  queuedAt: Date;
  reason: "opened" | "synchronized" | "re-review-requested";
}

export interface ReviewQueue {
  enqueue(candidate: ReviewCandidate): void;
  dequeue(): ReviewCandidate | undefined;
  list(): ReviewCandidate[];
  size(): number;
}

export function createReviewQueue(): ReviewQueue {
  const items: ReviewCandidate[] = [];

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
        items.splice(existing, 1);
      }
      if (items.length >= MAX_QUEUE_SIZE) {
        items.shift();
      }
      items.push(candidate);
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
  };
}
