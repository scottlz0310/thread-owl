// GitHub REST API operations

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head: { sha: string; ref: string };
  base: { sha: string; ref: string };
  htmlUrl: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | undefined;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export async function getPullRequest(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
): Promise<PullRequest> {
  throw new Error("not implemented");
}

export async function listPullRequestFiles(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
): Promise<PullRequestFile[]> {
  throw new Error("not implemented");
}

export async function createReview(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _body: string,
  _event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  _comments?: InlineComment[],
): Promise<void> {
  throw new Error("not implemented");
}

export async function createIssueComment(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}

export async function replyToReviewComment(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _commentId: number,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}
