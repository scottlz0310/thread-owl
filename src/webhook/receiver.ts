// Webhook HTTP endpoint
// TODO: implement with hono in Phase 4

export interface WebhookReceiverOptions {
  secret: string;
  port: number;
}

export function createWebhookReceiver(_options: WebhookReceiverOptions): unknown {
  throw new Error("not implemented");
}
