export interface SubscriptionSession {
  subscribe(uri: string): void;
  unsubscribe(uri: string): void;
  isSubscribed(uri: string): boolean;
  dispose(): void;
}

export function createSubscriptionSession(): SubscriptionSession {
  const subscriptions = new Set<string>();
  return {
    subscribe(uri: string): void {
      subscriptions.add(uri);
    },
    unsubscribe(uri: string): void {
      subscriptions.delete(uri);
    },
    isSubscribed(uri: string): boolean {
      return subscriptions.has(uri);
    },
    dispose(): void {
      subscriptions.clear();
    },
  };
}
