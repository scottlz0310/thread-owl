import { Hono } from "hono";
import type { Logger } from "../config/logging.js";
import { shouldIgnoreEvent } from "../policy/actor-policy.js";
import type { DeliveryDedup } from "../queue/delivery-dedup.js";
import type { ReviewQueue } from "../queue/review-queue.js";
import { handleIssueCommentEvent } from "./handlers/issue-comment.js";
import { handlePullRequestReviewCommentEvent } from "./handlers/pull-request-review-comment.js";
import { handlePullRequestReviewEvent } from "./handlers/pull-request-review.js";
import { handlePullRequestEvent } from "./handlers/pull-request.js";
import { normalizeEvent } from "./normalize-event.js";
import { isRecord } from "./utils.js";
import { verifyWebhookSignature } from "./verify-signature.js";

export interface WebhookReceiverDeps {
  secret: string;
  appSlug: string;
  dedup: DeliveryDedup;
  queue: ReviewQueue;
  logger: Logger;
  allowedRepos: readonly string[];
}

const SUPPORTED_EVENTS = new Set([
  "pull_request",
  "issue_comment",
  "pull_request_review",
  "pull_request_review_comment",
]);

function getSenderLogin(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const sender = payload.sender;
  if (!isRecord(sender) || typeof sender.login !== "string") return undefined;
  return sender.login;
}

export function createWebhookReceiver(deps: WebhookReceiverDeps): Hono {
  const app = new Hono();

  app.post("/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256") ?? "";
    const eventType = c.req.header("x-github-event") ?? "";
    const deliveryId = c.req.header("x-github-delivery") ?? "";
    const body = await c.req.text();

    if (!verifyWebhookSignature(body, signature, deps.secret)) {
      deps.logger.warn("webhook.signature.invalid", {
        event: "webhook.signature.invalid",
        deliveryId,
        eventType,
      });
      return c.json({ error: "invalid signature" }, 401);
    }

    if (deps.dedup.isSeen(deliveryId)) {
      return c.json({ status: "duplicate" }, 200);
    }
    deps.dedup.markSeen(deliveryId);

    if (!SUPPORTED_EVENTS.has(eventType)) {
      return c.json({ status: "ignored" }, 200);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const senderLogin = getSenderLogin(payload);
    if (senderLogin !== undefined && shouldIgnoreEvent(senderLogin, deps.appSlug)) {
      return c.json({ status: "skipped" }, 200);
    }

    let normalized: ReturnType<typeof normalizeEvent>;
    try {
      normalized = normalizeEvent(eventType, deliveryId, payload);
    } catch (err) {
      deps.logger.warn("webhook.normalize.error", {
        event: "webhook.normalize.error",
        eventType,
        deliveryId,
        errorMessage: err instanceof Error ? err.message : "unknown",
      });
      return c.json({ error: "payload normalization failed" }, 400);
    }

    try {
      if (normalized.type === "pull_request") {
        await handlePullRequestEvent(normalized, {
          queue: deps.queue,
          logger: deps.logger,
          allowedRepos: deps.allowedRepos,
        });
      } else if (normalized.type === "issue_comment") {
        await handleIssueCommentEvent(normalized, {
          logger: deps.logger,
          allowedRepos: deps.allowedRepos,
        });
      } else if (normalized.type === "pull_request_review") {
        await handlePullRequestReviewEvent(normalized, {
          logger: deps.logger,
          allowedRepos: deps.allowedRepos,
        });
      } else {
        await handlePullRequestReviewCommentEvent(normalized, {
          logger: deps.logger,
          allowedRepos: deps.allowedRepos,
        });
      }
    } catch (err) {
      deps.logger.error("webhook.handler.error", {
        event: "webhook.handler.error",
        eventType,
        deliveryId,
        errorName: err instanceof Error ? err.name : "UnknownError",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "handler failed" }, 500);
    }

    return c.json({ status: "ok" }, 200);
  });

  return app;
}
