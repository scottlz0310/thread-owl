export interface DeliveryDedup {
  isSeen(deliveryId: string): boolean;
  markSeen(deliveryId: string): void;
}

export function createDeliveryDedup(ttlMs = 24 * 60 * 60 * 1000): DeliveryDedup {
  const seen = new Map<string, number>(); // deliveryId → expiresAt (ms)

  return {
    isSeen(deliveryId: string): boolean {
      const expiresAt = seen.get(deliveryId);
      if (expiresAt === undefined) return false;
      if (Date.now() > expiresAt) {
        seen.delete(deliveryId);
        return false;
      }
      return true;
    },
    markSeen(deliveryId: string): void {
      seen.set(deliveryId, Date.now() + ttlMs);
    },
  };
}
