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
