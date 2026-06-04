// In-memory review candidate queue

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
  throw new Error("not implemented");
}
