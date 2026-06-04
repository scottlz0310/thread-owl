// GitHub GraphQL API operations (review threads require GraphQL)

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: ReviewThreadComment[];
}

export interface ReviewThreadComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  url: string;
}

export async function listReviewThreads(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
): Promise<ReviewThread[]> {
  throw new Error("not implemented");
}

export async function resolveReviewThread(_client: unknown, _threadId: string): Promise<void> {
  throw new Error("not implemented");
}
