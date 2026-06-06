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

const SUPPORTED_TYPES = new Set<string>([
  "pull_request",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function extractInstallationId(payload: Record<string, unknown>): number {
  const inst = payload.installation;
  if (!isRecord(inst) || typeof inst.id !== "number") {
    throw new Error("missing or invalid installation.id");
  }
  return inst.id;
}

function extractRepo(payload: Record<string, unknown>): { owner: string; repo: string } {
  const repository = payload.repository;
  if (!isRecord(repository)) throw new Error("missing repository");
  if (typeof repository.name !== "string") throw new Error("missing repository.name");
  const owner = repository.owner;
  if (!isRecord(owner) || typeof owner.login !== "string") {
    throw new Error("missing repository.owner.login");
  }
  return { owner: owner.login, repo: repository.name };
}

function extractPrNumber(
  type: WebhookEventType,
  payload: Record<string, unknown>,
): number | undefined {
  if (
    type === "pull_request" ||
    type === "pull_request_review" ||
    type === "pull_request_review_comment"
  ) {
    const pr = payload.pull_request;
    if (!isRecord(pr) || typeof pr.number !== "number") {
      throw new Error(`missing pull_request.number for event type ${type}`);
    }
    return pr.number;
  }
  if (type === "issue_comment") {
    const issue = payload.issue;
    if (isRecord(issue) && typeof issue.number === "number") {
      return issue.number;
    }
  }
  return undefined;
}

export function normalizeEvent(
  eventType: string,
  deliveryId: string,
  rawPayload: unknown,
): NormalizedEvent {
  if (!SUPPORTED_TYPES.has(eventType)) {
    throw new Error(`unsupported event type: ${eventType}`);
  }
  if (!isRecord(rawPayload)) throw new Error("payload must be a JSON object");

  const type = eventType as WebhookEventType;
  const installationId = extractInstallationId(rawPayload);
  const { owner, repo } = extractRepo(rawPayload);
  const prNumber = extractPrNumber(type, rawPayload);

  return { type, deliveryId, installationId, owner, repo, prNumber, payload: rawPayload };
}
