// Normalize raw GitHub webhook payloads into a unified event shape

export type WebhookEventType =
  | "pull_request"
  | "issue_comment"
  | "pull_request_review"
  | "pull_request_review_comment";

export interface NormalizedEvent {
  type: WebhookEventType;
  deliveryId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber?: number;
  payload: unknown;
}

export function normalizeEvent(
  _eventType: string,
  _deliveryId: string,
  _rawPayload: unknown,
): NormalizedEvent {
  throw new Error("not implemented");
}
