// High-level review thread operations

import type { GitHubClient } from "./client.js";
import { listReviewThreads } from "./graphql.js";
import type { ReviewThread } from "./graphql.js";

export type { ReviewThread };

// 未解決（unresolved）スレッドのみを返す高レベル API。
export async function listOpenThreads(
  client: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const threads = await listReviewThreads(client, owner, repo, prNumber);
  return threads.filter((thread) => !thread.isResolved);
}

// replyToThread / resolveThread（write）は #13 で実装する。
export async function replyToThread(
  _client: GitHubClient,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _threadId: string,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}

export async function resolveThread(_client: GitHubClient, _threadId: string): Promise<void> {
  throw new Error("not implemented");
}
