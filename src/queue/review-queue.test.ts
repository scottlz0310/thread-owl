import { describe, expect, test } from "vitest";
import { type ReviewCandidate, createReviewQueue } from "./review-queue.js";

function makeCandidate(
  prNumber: number,
  reason: ReviewCandidate["reason"] = "opened",
): ReviewCandidate {
  return {
    owner: "org",
    repo: "repo",
    prNumber,
    installationId: 1,
    queuedAt: new Date(),
    reason,
  };
}

describe("createReviewQueue", () => {
  test("enqueue and dequeue in FIFO order", () => {
    const q = createReviewQueue();
    q.enqueue(makeCandidate(1));
    q.enqueue(makeCandidate(2));
    q.enqueue(makeCandidate(3));

    expect(q.dequeue()?.prNumber).toBe(1);
    expect(q.dequeue()?.prNumber).toBe(2);
    expect(q.dequeue()?.prNumber).toBe(3);
    expect(q.dequeue()).toBeUndefined();
  });

  test("size reflects current count", () => {
    const q = createReviewQueue();
    expect(q.size()).toBe(0);
    q.enqueue(makeCandidate(1));
    expect(q.size()).toBe(1);
    q.dequeue();
    expect(q.size()).toBe(0);
  });

  test("list returns snapshot without mutating queue", () => {
    const q = createReviewQueue();
    q.enqueue(makeCandidate(1));
    q.enqueue(makeCandidate(2));

    const snapshot = q.list();
    expect(snapshot).toHaveLength(2);
    snapshot.pop();
    expect(q.size()).toBe(2);
  });

  describe("PR-unit dedup", () => {
    test.each([
      { first: "opened", second: "synchronized", desc: "opened then synchronized" },
      {
        first: "synchronized",
        second: "re-review-requested",
        desc: "synchronized then re-review-requested",
      },
    ])("replaces existing entry for same PR ($desc)", ({ first, second }) => {
      const q = createReviewQueue();
      q.enqueue(makeCandidate(1, first as ReviewCandidate["reason"]));
      q.enqueue(makeCandidate(1, second as ReviewCandidate["reason"]));

      expect(q.size()).toBe(1);
      expect(q.dequeue()?.reason).toBe(second);
    });

    test("dedup preserves queue position at tail", () => {
      const q = createReviewQueue();
      q.enqueue(makeCandidate(1));
      q.enqueue(makeCandidate(2));
      q.enqueue(makeCandidate(1, "synchronized")); // moves PR#1 to tail

      const items = q.list();
      expect(items.map((i) => i.prNumber)).toEqual([2, 1]);
    });

    test("different repos with same PR number are not deduped", () => {
      const q = createReviewQueue();
      q.enqueue({ ...makeCandidate(1), repo: "repo-a" });
      q.enqueue({ ...makeCandidate(1), repo: "repo-b" });

      expect(q.size()).toBe(2);
    });
  });

  describe("size limit", () => {
    test("drops oldest entry when limit (100) is reached", () => {
      const q = createReviewQueue();
      for (let i = 1; i <= 100; i++) {
        q.enqueue(makeCandidate(i));
      }
      expect(q.size()).toBe(100);
      expect(q.list()[0].prNumber).toBe(1);

      q.enqueue(makeCandidate(101));
      expect(q.size()).toBe(100);
      expect(q.list()[0].prNumber).toBe(2);
    });
  });

  describe("onEnqueue", () => {
    test("listener is called on each enqueue", () => {
      const q = createReviewQueue();
      const calls: number[] = [];
      q.onEnqueue(() => calls.push(q.size()));

      q.enqueue(makeCandidate(1));
      q.enqueue(makeCandidate(2));

      expect(calls).toEqual([1, 2]);
    });

    test("returned dispose removes the listener", () => {
      const q = createReviewQueue();
      let count = 0;
      const dispose = q.onEnqueue(() => count++);

      q.enqueue(makeCandidate(1));
      dispose();
      q.enqueue(makeCandidate(2));

      expect(count).toBe(1);
    });

    test("multiple listeners are each called", () => {
      const q = createReviewQueue();
      let a = 0;
      let b = 0;
      q.onEnqueue(() => a++);
      q.onEnqueue(() => b++);

      q.enqueue(makeCandidate(1));

      expect(a).toBe(1);
      expect(b).toBe(1);
    });

    test("listener is called even when enqueue deduplicates same PR", () => {
      const q = createReviewQueue();
      let count = 0;
      q.onEnqueue(() => count++);

      q.enqueue(makeCandidate(1, "opened"));
      q.enqueue(makeCandidate(1, "synchronized"));

      expect(count).toBe(2);
    });
  });
});
