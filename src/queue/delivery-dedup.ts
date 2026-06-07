export interface DeliveryDedup {
  isSeen(deliveryId: string): boolean;
  markSeen(deliveryId: string): void;
  dispose(): void;
}

export function createDeliveryDedup(
  ttlMs = 24 * 60 * 60 * 1000,
  gcIntervalMs = 60 * 60 * 1000,
): DeliveryDedup {
  const seen = new Map<string, number>(); // deliveryId → expiresAt (ms)

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, expiresAt] of seen) {
      if (now > expiresAt) seen.delete(id);
    }
  }, gcIntervalMs);
  // プロセス終了をブロックしない（Node.js 環境のみ）
  (timer as NodeJS.Timeout).unref?.();

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
    dispose(): void {
      clearInterval(timer);
    },
  };
}
