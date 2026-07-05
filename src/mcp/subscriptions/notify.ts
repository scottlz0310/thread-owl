import type { Logger } from "../../config/logging.js";
import type { SubscriptionSession } from "./listen.js";

export interface QueueNotifier {
  /** SubscribeRequestSchema ハンドラから呼ぶ。既に subscribe 済みなら no-op。 */
  handleSubscribe(): void;
  /** UnsubscribeRequestSchema ハンドラから呼ぶ。 */
  handleUnsubscribe(): void;
  dispose(): void;
}

// 長時間稼働時の通知配信停止（#117）の診断用。渡すと subscribe/unsubscribe/配信失敗のたびに
// listener 数を記録する。sendUpdated が resolve した場合でも実際にクライアントへ届いたかは
// MCP SDK の standalone SSE 仕様上ここからは確認できないため、reject（＝失敗を検知できたケース）のみログする。
export interface NotifierDiagnostics {
  logger: Logger;
  listenerCount: () => number;
}

export function createQueueNotifier(
  onHook: (listener: () => void) => () => void,
  sendUpdated: (uri: string) => Promise<void>,
  session: SubscriptionSession,
  uri: string,
  diagnostics?: NotifierDiagnostics,
): QueueNotifier {
  let removeListener: (() => void) | undefined;

  // subscribe のたびに新しいリスナーを生成することで、
  // pending 中の sendUpdated が reject されても re-subscribe 後の新リスナーを誤解除しない。
  function attachListener(): void {
    removeListener?.();
    removeListener = onHook(() => {
      if (!session.isSubscribed(uri)) return;
      const selfRemove = removeListener;
      void sendUpdated(uri).catch((error) => {
        if (removeListener === selfRemove) {
          session.unsubscribe(uri);
          removeListener?.();
          removeListener = undefined;
          if (diagnostics) {
            diagnostics.logger.warn("mcp.subscription.notify.failed", {
              event: "mcp.subscription.notify.failed",
              uri,
              listenerCount: diagnostics.listenerCount(),
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
    });
  }

  return {
    handleSubscribe(): void {
      if (session.isSubscribed(uri)) return;
      session.subscribe(uri);
      attachListener();
      if (diagnostics) {
        diagnostics.logger.debug("mcp.subscription.subscribed", {
          event: "mcp.subscription.subscribed",
          uri,
          listenerCount: diagnostics.listenerCount(),
        });
      }
    },
    handleUnsubscribe(): void {
      session.unsubscribe(uri);
      removeListener?.();
      removeListener = undefined;
      if (diagnostics) {
        diagnostics.logger.debug("mcp.subscription.unsubscribed", {
          event: "mcp.subscription.unsubscribed",
          uri,
          listenerCount: diagnostics.listenerCount(),
        });
      }
    },
    dispose(): void {
      removeListener?.();
      removeListener = undefined;
    },
  };
}
