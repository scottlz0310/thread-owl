import { describe, expect, test, vi } from "vitest";
import { createReviewQueue, type ReviewCandidate } from "../../queue/review-queue.js";
import { createSubscriptionSession } from "./listen.js";
import { createQueueNotifier } from "./notify.js";

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
  const notifier = createQueueNotifier(queue, sendUpdated, session, TEST_URI);
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
});
