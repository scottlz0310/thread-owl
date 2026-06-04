// Webhook delivery deduplication by delivery ID (with TTL)

export interface DeliveryDedup {
  isSeen(deliveryId: string): boolean;
  markSeen(deliveryId: string): void;
}

export function createDeliveryDedup(_ttlMs?: number): DeliveryDedup {
  throw new Error("not implemented");
}
