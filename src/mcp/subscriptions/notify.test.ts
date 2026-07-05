import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../../config/logging.js";
import { createReviewQueue, type ReviewCandidate } from "../../queue/review-queue.js";
import { createSubscriptionSession } from "./listen.js";
import { createQueueNotifier } from "./notify.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const TEST_URI = "queue://review/queue";

function makeCandidate(prNumber = 1): ReviewCandidate {
  return {
    owner: "org",
    repo: "repo",
    prNumber,
    installationId: 1,
    queuedAt: new Date(),
    reason: "opened",
  };
}

function setup(overrides?: { sendUpdated?: (uri: string) => Promise<void> }) {
  const queue = createReviewQueue();
  const session = createSubscriptionSession();
  const sendUpdated = overrides?.sendUpdated ?? vi.fn().mockResolvedValue(undefined);
  const notifier = createQueueNotifier(
    (listener) => queue.onEnqueue(listener),
    sendUpdated,
    session,
    TEST_URI,
  );
  return { queue, session, sendUpdated, notifier };
}

describe("createQueueNotifier", () => {
  test("subscribe 前に enqueue しても sendUpdated は呼ばれない", async () => {
    const { queue, notifier, sendUpdated } = setup();
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUpdated).not.toHaveBeenCalled();
    notifier.dispose();
  });

  test("subscribe 後に enqueue すると sendUpdated が呼ばれる", async () => {
    const { queue, notifier, sendUpdated } = setup();
    notifier.handleSubscribe();
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUpdated).toHaveBeenCalledOnce();
    expect(sendUpdated).toHaveBeenCalledWith(TEST_URI);
    notifier.dispose();
  });

  test("unsubscribe 後に enqueue しても sendUpdated は呼ばれない", async () => {
    const { queue, notifier, sendUpdated } = setup();
    notifier.handleSubscribe();
    notifier.handleUnsubscribe();
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUpdated).not.toHaveBeenCalled();
    notifier.dispose();
  });

  test("subscribe → unsubscribe → re-subscribe: enqueue で sendUpdated が 1 回だけ呼ばれる", async () => {
    const { queue, notifier, sendUpdated } = setup();
    notifier.handleSubscribe();
    notifier.handleUnsubscribe();
    notifier.handleSubscribe();
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUpdated).toHaveBeenCalledOnce();
    notifier.dispose();
  });

  test("重複 subscribe は no-op（2 回目は listener を追加しない）", async () => {
    const { queue, notifier, sendUpdated } = setup();
    notifier.handleSubscribe();
    notifier.handleSubscribe();
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUpdated).toHaveBeenCalledOnce();
    notifier.dispose();
  });

  test("dispose は session.dispose() を呼ばない（session のライフサイクルは caller が管理する）", () => {
    const { notifier, session } = setup();
    notifier.handleSubscribe();
    notifier.dispose();
    // session は依然として subscribe 状態のまま — notifier が session を壊さない
    expect(session.isSubscribed(TEST_URI)).toBe(true);
  });

  test("dispose 後に enqueue しても sendUpdated は呼ばれない", async () => {
    const { queue, notifier, sendUpdated } = setup();
    notifier.handleSubscribe();
    notifier.dispose();
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUpdated).not.toHaveBeenCalled();
  });

  test("sendUpdated 失敗時に unsubscribe され、以降の enqueue では sendUpdated が呼ばれない", async () => {
    const sendUpdated = vi.fn().mockRejectedValue(new Error("transport closed"));
    const { queue, notifier, session } = setup({ sendUpdated });
    notifier.handleSubscribe();
    queue.enqueue(makeCandidate());
    await new Promise((r) => setTimeout(r, 10));
    // 失敗後は session が unsubscribed になっている
    expect(session.isSubscribed(TEST_URI)).toBe(false);
    // 再 enqueue でも sendUpdated が呼ばれない
    queue.enqueue(makeCandidate(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(sendUpdated).toHaveBeenCalledOnce();
    notifier.dispose();
  });

  test("pending 中の sendUpdated 失敗が re-subscribe 後の新リスナーを解除しない", async () => {
    let rejectSend!: () => void;
    const deferred = new Promise<void>((_, reject) => {
      rejectSend = () => reject(new Error("transport closed"));
    });
    const laterSend = vi.fn().mockResolvedValue(undefined);
    let callCount = 0;
    const sendUpdated = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? deferred : laterSend();
    });

    const { queue, notifier } = setup({ sendUpdated });

    notifier.handleSubscribe();
    queue.enqueue(makeCandidate(1)); // sendUpdated が pending になる

    // pending 中に unsubscribe → re-subscribe
    notifier.handleUnsubscribe();
    notifier.handleSubscribe();

    // 旧 sendUpdated を reject
    rejectSend();
    await new Promise((r) => setTimeout(r, 10));

    // 新リスナーが有効なら enqueue 2 で通知が届く
    queue.enqueue(makeCandidate(2));
    await new Promise((r) => setTimeout(r, 10));

    expect(sendUpdated).toHaveBeenCalledTimes(2);
    notifier.dispose();
  });

  describe("diagnostics（#117 通知配信停止の診断ログ）", () => {
    test("diagnostics 未指定なら logger は一切呼ばれない", async () => {
      const sendUpdated = vi.fn().mockRejectedValue(new Error("transport closed"));
      const { queue, notifier } = setup({ sendUpdated });
      notifier.handleSubscribe();
      notifier.handleUnsubscribe();
      queue.enqueue(makeCandidate());
      await new Promise((r) => setTimeout(r, 10));
      notifier.dispose();
      // logger を渡していないので例外なく動作することのみ確認する
      expect(sendUpdated).not.toHaveBeenCalled();
    });

    test("handleSubscribe で subscribed ログと listenerCount を記録する", () => {
      const queue = createReviewQueue();
      const session = createSubscriptionSession();
      const logger = makeLogger();
      queue.onEnqueue(() => {});
      const notifier = createQueueNotifier(
        (listener) => queue.onEnqueue(listener),
        vi.fn().mockResolvedValue(undefined),
        session,
        TEST_URI,
        { logger, listenerCount: () => queue.listenerCounts().onEnqueue },
      );

      notifier.handleSubscribe();

      expect(logger.info).toHaveBeenCalledWith(
        "mcp.subscription.subscribed",
        expect.objectContaining({ uri: TEST_URI, listenerCount: 2 }),
      );
      notifier.dispose();
    });

    test("handleUnsubscribe で unsubscribed ログを記録する", () => {
      const queue = createReviewQueue();
      const session = createSubscriptionSession();
      const logger = makeLogger();
      const notifier = createQueueNotifier(
        (listener) => queue.onEnqueue(listener),
        vi.fn().mockResolvedValue(undefined),
        session,
        TEST_URI,
        { logger, listenerCount: () => queue.listenerCounts().onEnqueue },
      );

      notifier.handleSubscribe();
      notifier.handleUnsubscribe();

      expect(logger.info).toHaveBeenCalledWith(
        "mcp.subscription.unsubscribed",
        expect.objectContaining({ uri: TEST_URI, listenerCount: 0 }),
      );
      notifier.dispose();
    });

    test("sendUpdated 失敗時に notify.failed を warn で記録する", async () => {
      const queue = createReviewQueue();
      const session = createSubscriptionSession();
      const logger = makeLogger();
      const sendUpdated = vi.fn().mockRejectedValue(new Error("transport closed"));
      const notifier = createQueueNotifier(
        (listener) => queue.onEnqueue(listener),
        sendUpdated,
        session,
        TEST_URI,
        { logger, listenerCount: () => queue.listenerCounts().onEnqueue },
      );

      notifier.handleSubscribe();
      queue.enqueue(makeCandidate());
      await new Promise((r) => setTimeout(r, 10));

      expect(logger.warn).toHaveBeenCalledWith(
        "mcp.subscription.notify.failed",
        expect.objectContaining({ uri: TEST_URI, error: "transport closed" }),
      );
      notifier.dispose();
    });

    test("sendUpdated が Error 以外の値で reject した場合も notify.failed を記録する", async () => {
      const queue = createReviewQueue();
      const session = createSubscriptionSession();
      const logger = makeLogger();
      const sendUpdated = vi.fn().mockRejectedValue("plain string rejection");
      const notifier = createQueueNotifier(
        (listener) => queue.onEnqueue(listener),
        sendUpdated,
        session,
        TEST_URI,
        { logger, listenerCount: () => queue.listenerCounts().onEnqueue },
      );

      notifier.handleSubscribe();
      queue.enqueue(makeCandidate());
      await new Promise((r) => setTimeout(r, 10));

      expect(logger.warn).toHaveBeenCalledWith(
        "mcp.subscription.notify.failed",
        expect.objectContaining({ uri: TEST_URI, error: "plain string rejection" }),
      );
      notifier.dispose();
    });
  });
});
