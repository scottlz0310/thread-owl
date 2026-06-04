// High-level review thread operations

import type { ReviewThread } from "./graphql.js";

export type { ReviewThread };

export async function listOpenThreads(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
): Promise<ReviewThread[]> {
  throw new Error("not implemented");
}

export async function replyToThread(
  _client: unknown,
  _owner: string,
  _repo: string,
  _prNumber: number,
  _threadId: string,
  _body: string,
): Promise<void> {
  throw new Error("not implemented");
}

export async function resolveThread(_client: unknown, _threadId: string): Promise<void> {
  throw new Error("not implemented");
}
