import type { ReviewQueue } from "../../queue/review-queue.js";
import type { SubscriptionSession } from "./listen.js";

export interface QueueNotifier {
  /** SubscribeRequestSchema ハンドラから呼ぶ。既に subscribe 済みなら no-op。 */
  handleSubscribe(): void;
  /** UnsubscribeRequestSchema ハンドラから呼ぶ。 */
  handleUnsubscribe(): void;
  dispose(): void;
}

export function createQueueNotifier(
  queue: ReviewQueue,
  sendUpdated: (uri: string) => Promise<void>,
  session: SubscriptionSession,
  uri: string,
): QueueNotifier {
  let removeListener: (() => void) | undefined;

  // subscribe のたびに新しいリスナーを生成することで、
  // pending 中の sendUpdated が reject されても re-subscribe 後の新リスナーを誤解除しない。
  function attachListener(): void {
    removeListener?.();
    removeListener = queue.onEnqueue(() => {
      if (!session.isSubscribed(uri)) return;
      const selfRemove = removeListener;
      void sendUpdated(uri).catch(() => {
        if (removeListener === selfRemove) {
          session.unsubscribe(uri);
          removeListener?.();
          removeListener = undefined;
        }
      });
    });
  }

  return {
    handleSubscribe(): void {
      if (session.isSubscribed(uri)) return;
      session.subscribe(uri);
      attachListener();
    },
    handleUnsubscribe(): void {
      session.unsubscribe(uri);
      removeListener?.();
      removeListener = undefined;
    },
    dispose(): void {
      session.dispose();
      removeListener?.();
      removeListener = undefined;
    },
  };
}
