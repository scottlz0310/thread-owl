import { describe, expect, test, vi } from "vitest";
import {
  createReviewStatusStore,
  type ReviewStatus,
  type ReviewStatusStore,
} from "./review-status.js";

const pr = { owner: "org", repo: "repo", prNumber: 1 };

describe("createReviewStatusStore", () => {
  test("同HEADの再enqueueと再起動でもattemptIdを再利用しない", () => {
    const store = createReviewStatusStore();
    store.markPending(pr, "abc");
    const first = store.get(pr)?.attemptId;
    store.markPending(pr, "abc");
    const restarted = createReviewStatusStore();
    restarted.markPending(pr, "abc");
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get(pr)?.attemptId).not.toBe(first);
    expect(restarted.get(pr)?.attemptId).not.toBe(first);
  });

  test("停止後は同一roundの完了更新を拒否し、次enqueueでのみ再開する", () => {
    const store = createReviewStatusStore();
    store.markPending(pr, "abc");
    const attemptId = store.get(pr)?.attemptId as string;
    const round = store.currentRound(pr);
    expect(
      store.markStopped(pr, {
        attemptId,
        headSha: "abc",
        stop: { notificationId: "n", commentId: 1, code: "STALE_REVIEW", currentHeadSha: "def" },
      }),
    ).toBe(true);
    expect(store.markReviewed(pr, { round, summaryCommentId: 2 })).toBe(false);
    expect(store.markApproved(pr, { round, headSha: "abc" })).toBe(false);
    expect(store.get(pr)?.status).toBe("stopped");
    store.markPending(pr, "abc");
    expect(store.get(pr)).toMatchObject({ status: "pending", summaryCommentId: null });
    expect(store.get(pr)?.stop).toBeUndefined();
  });

  test.each(["head", "attempt", "completed"])("markStoppedは%s不一致を通知しない", (kind) => {
    const store = createReviewStatusStore();
    store.markPending(pr, "abc");
    const attemptId = store.get(pr)?.attemptId as string;
    if (kind === "completed")
      store.markApproved(pr, { round: store.currentRound(pr), headSha: "abc" });
    const listener = vi.fn();
    store.onUpdated(listener);
    expect(
      store.markStopped(pr, {
        attemptId: kind === "attempt" ? "other" : attemptId,
        headSha: kind === "head" ? "other" : "abc",
        stop: { notificationId: "n", commentId: 1, code: "STALE_REVIEW", currentHeadSha: "def" },
      }),
    ).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
  test("markPending は headSha / summaryCommentId を null で初期化する", () => {
    const store = createReviewStatusStore();

    store.markPending(pr);

    expect(store.get(pr)).toMatchObject({
      ...pr,
      status: "pending",
      headSha: null,
      summaryCommentId: null,
    });
  });

  test.each([
    { headSha: "abc", expected: "abc" },
    { headSha: undefined, expected: null },
  ])("markReviewed は headSha=$headSha を $expected として記録する", ({ headSha, expected }) => {
    const store = createReviewStatusStore();

    store.markReviewed(pr, { summaryCommentId: 10, headSha, round: undefined });

    expect(store.get(pr)).toMatchObject({
      status: "reviewed",
      summaryCommentId: 10,
      headSha: expected,
    });
  });

  test("markApproved は直前のサマリーコメント ID を引き継ぐ", () => {
    const store = createReviewStatusStore();

    store.markReviewed(pr, { summaryCommentId: 10, round: undefined });
    store.markApproved(pr, { headSha: "def", round: undefined });

    expect(store.get(pr)).toMatchObject({
      status: "approved",
      summaryCommentId: 10,
      headSha: "def",
    });
  });

  test("markPending は前ラウンドの完了状態をリセットする", () => {
    const store = createReviewStatusStore();

    store.markApproved(pr, { headSha: "def", round: undefined });
    store.markReviewed(pr, { summaryCommentId: 10, headSha: "def", round: undefined });
    store.markPending(pr);

    expect(store.get(pr)).toMatchObject({
      status: "pending",
      headSha: null,
      summaryCommentId: null,
    });
  });

  test.each([
    {
      name: "markPending",
      mark: (s: ReviewStatusStore) => s.markPending(pr),
      calls: 0,
    },
    {
      name: "markReviewed",
      mark: (s: ReviewStatusStore) => s.markReviewed(pr, { summaryCommentId: 1, round: undefined }),
      calls: 1,
    },
    {
      name: "markApproved",
      mark: (s: ReviewStatusStore) => s.markApproved(pr, { headSha: "a", round: undefined }),
      calls: 1,
    },
  ])("$name の listener 呼び出し回数は $calls", ({ mark, calls }) => {
    const store = createReviewStatusStore();
    const received: ReviewStatus[] = [];
    store.onUpdated((status) => received.push(status));

    mark(store);

    expect(received).toHaveLength(calls);
  });

  test.each([
    {
      name: "markReviewed",
      complete: (s: ReviewStatusStore, round: number | undefined) =>
        s.markReviewed(pr, { summaryCommentId: 1, round }),
    },
    {
      name: "markApproved",
      complete: (s: ReviewStatusStore, round: number | undefined) =>
        s.markApproved(pr, { headSha: "a", round }),
    },
  ])(
    "$name は捕捉後に次ラウンドが始まっていたら pending を上書きせず通知もしない",
    ({ complete }) => {
      const store = createReviewStatusStore();
      const received: ReviewStatus[] = [];
      store.onUpdated((status) => received.push(status));
      store.markPending(pr);
      const round = store.currentRound(pr);

      store.markPending(pr);
      const applied = complete(store, round);

      expect(applied).toBe(false);
      expect(store.get(pr)?.status).toBe("pending");
      expect(received).toHaveLength(0);
    },
  );

  test("未追跡で捕捉した更新は、完了前に pending が作られていたら破棄する", () => {
    const store = createReviewStatusStore();
    const round = store.currentRound(pr);

    store.markPending(pr);

    expect(store.markReviewed(pr, { summaryCommentId: 1, round })).toBe(false);
    expect(store.get(pr)?.status).toBe("pending");
  });

  test("同一ラウンド内なら reviewed の後に approved へ進める", () => {
    const store = createReviewStatusStore();
    store.markPending(pr);
    const round = store.currentRound(pr);

    expect(store.markReviewed(pr, { summaryCommentId: 1, round })).toBe(true);
    expect(store.markApproved(pr, { headSha: "a", round })).toBe(true);
    expect(store.get(pr)).toMatchObject({ status: "approved", summaryCommentId: 1 });
  });

  test("破棄後に再登録された PR のラウンドは過去の値と衝突しない", () => {
    const store = createReviewStatusStore();
    store.markPending(pr);
    const staleRound = store.currentRound(pr);
    for (let prNumber = 2; prNumber <= 101; prNumber++) {
      store.markPending({ ...pr, prNumber });
    }
    expect(store.get(pr)).toBeUndefined();

    store.markPending(pr);

    expect(store.markReviewed(pr, { summaryCommentId: 1, round: staleRound })).toBe(false);
  });

  test("解除関数で listener を外せる", () => {
    const store = createReviewStatusStore();
    let count = 0;
    const off = store.onUpdated(() => count++);

    off();
    store.markReviewed(pr, { summaryCommentId: 1, round: undefined });

    expect(count).toBe(0);
  });

  test("owner/repo の大文字小文字違いは同一 PR として扱う", () => {
    const store = createReviewStatusStore();

    store.markPending(pr);
    store.markReviewed(
      { owner: "ORG", repo: "Repo", prNumber: 1 },
      { summaryCommentId: 1, round: store.currentRound(pr) },
    );

    expect(store.list()).toHaveLength(1);
    expect(store.get(pr)?.status).toBe("reviewed");
  });

  test("上限を超えたら最も古く更新された PR から破棄する", () => {
    const store = createReviewStatusStore();

    for (let prNumber = 1; prNumber <= 100; prNumber++) {
      store.markPending({ ...pr, prNumber });
    }
    // 1 番を更新して最新扱いにすると、次の追加で 2 番が破棄される。
    const first = { ...pr, prNumber: 1 };
    store.markReviewed(first, { summaryCommentId: 1, round: store.currentRound(first) });
    store.markPending({ ...pr, prNumber: 101 });

    expect(store.list()).toHaveLength(100);
    expect(store.get({ ...pr, prNumber: 1 })).toBeDefined();
    expect(store.get({ ...pr, prNumber: 2 })).toBeUndefined();
    expect(store.get({ ...pr, prNumber: 101 })).toBeDefined();
  });
});
