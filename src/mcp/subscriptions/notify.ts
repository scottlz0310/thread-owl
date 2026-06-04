// Push notifications to MCP subscribers

export type NotificationEvent =
  | "pr_opened"
  | "pr_synchronized"
  | "review_comment_created"
  | "review_thread_replied"
  | "review_requested"
  | "review_ready"
  | "review_stale";

export interface Notification {
  event: NotificationEvent;
  owner: string;
  repo: string;
  prNumber: number;
  details?: Record<string, unknown>;
}

export async function notifySubscribers(
  _server: unknown,
  _notification: Notification,
): Promise<void> {
  throw new Error("not implemented");
}
