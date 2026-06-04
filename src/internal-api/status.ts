// Application status endpoint

export interface ReviewQueueStatus {
  pending: number;
}

export interface AppStatus {
  queue: ReviewQueueStatus;
  startedAt: string;
}

export function getStatus(): AppStatus {
  throw new Error("not implemented");
}
