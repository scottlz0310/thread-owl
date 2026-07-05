import { describe, expect, test } from "vitest";
import { createReviewQueue, type ReviewCandidate } from "./review-queue.js";

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

    test("owner/repo の大小文字違いは同一 PR として dedup される", () => {
      const q = createReviewQueue();
      q.enqueue({ ...makeCandidate(1), owner: "org", repo: "repo" });
      q.enqueue({ ...makeCandidate(1), owner: "ORG", repo: "REPO" });

      expect(q.size()).toBe(1);
    });
  });

  describe("re-review-requested 優先度", () => {
    test("re-review-requested → synchronized: synchronized は上書きしない（webhook 到着順: comment first）", () => {
      const q = createReviewQueue();
      q.enqueue(makeCandidate(1, "re-review-requested"));
      q.enqueue(makeCandidate(1, "synchronized"));

      expect(q.size()).toBe(1);
      expect(q.dequeue()?.reason).toBe("re-review-requested");
    });

    test("synchronized → re-review-requested: re-review-requested が上書きする（webhook 到着順: push first）", () => {
      const q = createReviewQueue();
      q.enqueue(makeCandidate(1, "synchronized"));
      q.enqueue(makeCandidate(1, "re-review-requested"));

      expect(q.size()).toBe(1);
      expect(q.dequeue()?.reason).toBe("re-review-requested");
    });

    test("re-review-requested → opened: opened は上書きしない", () => {
      const q = createReviewQueue();
      q.enqueue(makeCandidate(1, "re-review-requested"));
      q.enqueue(makeCandidate(1, "opened"));

      expect(q.size()).toBe(1);
      expect(q.dequeue()?.reason).toBe("re-review-requested");
    });

    test("re-review-requested → re-review-requested: 新しい依頼で上書きする", () => {
      const q = createReviewQueue();
      const first = {
        ...makeCandidate(1, "re-review-requested"),
        sourceCommentId: 100,
        requestedBy: "alice",
      };
      const second = {
        ...makeCandidate(1, "re-review-requested"),
        sourceCommentId: 200,
        requestedBy: "bob",
      };
      q.enqueue(first);
      q.enqueue(second);

      const result = q.dequeue();
      expect(result?.reason).toBe("re-review-requested");
      expect(result?.sourceCommentId).toBe(200);
      expect(result?.requestedBy).toBe("bob");
    });

    test("re-review-requested → synchronized: priority guard で synchronized は enqueue されない（通知なし）", () => {
      const q = createReviewQueue();
      let count = 0;
      q.onEnqueue(() => count++);

      q.enqueue(makeCandidate(1, "re-review-requested"));
      q.enqueue(makeCandidate(1, "synchronized")); // priority guard で早期 return

      expect(count).toBe(1); // re-review-requested の enqueue のみ
    });

    test("synchronized → re-review-requested: push-first では両方通知され queue 最終状態は re-review-requested", () => {
      const q = createReviewQueue();
      const notifiedReasons: string[] = [];
      q.onEnqueue(() => {
        const top = q.list()[0];
        if (top) notifiedReasons.push(top.reason);
      });

      q.enqueue(makeCandidate(1, "synchronized")); // 通知する（architecture 契約）
      q.enqueue(makeCandidate(1, "re-review-requested")); // synchronized を置き換えて通知する

      expect(notifiedReasons).toEqual(["synchronized", "re-review-requested"]);
      expect(q.dequeue()?.reason).toBe("re-review-requested");
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

    test("通常の opened → synchronized は両方で listener を呼ぶ（architecture 契約）", () => {
      const q = createReviewQueue();
      let count = 0;
      q.onEnqueue(() => count++);

      q.enqueue(makeCandidate(1, "opened"));
      q.enqueue(makeCandidate(1, "synchronized")); // 通常の PR 更新は通知する

      expect(count).toBe(2);
    });
  });

  describe("onReReviewRequested", () => {
    test("re-review-requested enqueue 時のみ listener を呼ぶ", () => {
      const q = createReviewQueue();
      let count = 0;
      q.onReReviewRequested(() => count++);

      q.enqueue(makeCandidate(1, "opened"));
      q.enqueue(makeCandidate(2, "synchronized"));
      q.enqueue(makeCandidate(3, "re-review-requested"));

      expect(count).toBe(1);
    });

    test("opened / synchronized では呼ばれない", () => {
      const q = createReviewQueue();
      const reasons: string[] = [];
      q.onReReviewRequested(() => reasons.push("fired"));

      q.enqueue(makeCandidate(1, "opened"));
      q.enqueue(makeCandidate(2, "synchronized"));

      expect(reasons).toHaveLength(0);
    });

    test("returned dispose で listener を解除できる", () => {
      const q = createReviewQueue();
      let count = 0;
      const dispose = q.onReReviewRequested(() => count++);

      q.enqueue(makeCandidate(1, "re-review-requested"));
      dispose();
      q.enqueue(makeCandidate(2, "re-review-requested"));

      expect(count).toBe(1);
    });

    test("onEnqueue と onReReviewRequested は独立して発火する", () => {
      const q = createReviewQueue();
      let allCount = 0;
      let reReviewCount = 0;
      q.onEnqueue(() => allCount++);
      q.onReReviewRequested(() => reReviewCount++);

      q.enqueue(makeCandidate(1, "opened"));
      q.enqueue(makeCandidate(2, "synchronized"));
      q.enqueue(makeCandidate(3, "re-review-requested"));

      expect(allCount).toBe(3);
      expect(reReviewCount).toBe(1);
    });

    test("push-first（synchronized → re-review-requested）: onReReviewRequested は synchronized では発火しない", () => {
      const q = createReviewQueue();
      const reReviewNotified: string[] = [];
      q.onReReviewRequested(() => {
        const top = q.list()[0];
        if (top) reReviewNotified.push(top.reason);
      });

      q.enqueue(makeCandidate(1, "synchronized")); // onReReviewRequested は発火しない
      q.enqueue(makeCandidate(1, "re-review-requested")); // 発火する

      expect(reReviewNotified).toEqual(["re-review-requested"]);
    });
  });
});
