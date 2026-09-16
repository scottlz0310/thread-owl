import { describe, expect, test } from "vitest";
import {
  createReviewStatusStore,
  type ReviewStatus,
  type ReviewStatusStore,
} from "./review-status.js";

const pr = { owner: "org", repo: "repo", prNumber: 1 };

describe("createReviewStatusStore", () => {
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

    store.markReviewed(pr, { summaryCommentId: 10, headSha });

    expect(store.get(pr)).toMatchObject({
      status: "reviewed",
      summaryCommentId: 10,
      headSha: expected,
    });
  });

  test("markApproved は直前のサマリーコメント ID を引き継ぐ", () => {
    const store = createReviewStatusStore();

    store.markReviewed(pr, { summaryCommentId: 10 });
    store.markApproved(pr, { headSha: "def" });

    expect(store.get(pr)).toMatchObject({
      status: "approved",
      summaryCommentId: 10,
      headSha: "def",
    });
  });

  test("markPending は前ラウンドの完了状態をリセットする", () => {
    const store = createReviewStatusStore();

    store.markApproved(pr, { headSha: "def" });
    store.markReviewed(pr, { summaryCommentId: 10, headSha: "def" });
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
      mark: (s: ReviewStatusStore) => s.markReviewed(pr, { summaryCommentId: 1 }),
      calls: 1,
    },
    {
      name: "markApproved",
      mark: (s: ReviewStatusStore) => s.markApproved(pr, { headSha: "a" }),
      calls: 1,
    },
  ])("$name の listener 呼び出し回数は $calls", ({ mark, calls }) => {
    const store = createReviewStatusStore();
    const received: ReviewStatus[] = [];
    store.onUpdated((status) => received.push(status));

    mark(store);

    expect(received).toHaveLength(calls);
  });

  test("解除関数で listener を外せる", () => {
    const store = createReviewStatusStore();
    let count = 0;
    const off = store.onUpdated(() => count++);

    off();
    store.markReviewed(pr, { summaryCommentId: 1 });

    expect(count).toBe(0);
  });

  test("owner/repo の大文字小文字違いは同一 PR として扱う", () => {
    const store = createReviewStatusStore();

    store.markPending(pr);
    store.markReviewed({ owner: "ORG", repo: "Repo", prNumber: 1 }, { summaryCommentId: 1 });

    expect(store.list()).toHaveLength(1);
    expect(store.get(pr)?.status).toBe("reviewed");
  });

  test("上限を超えたら最も古く更新された PR から破棄する", () => {
    const store = createReviewStatusStore();

    for (let prNumber = 1; prNumber <= 100; prNumber++) {
      store.markPending({ ...pr, prNumber });
    }
    // 1 番を更新して最新扱いにすると、次の追加で 2 番が破棄される。
    store.markReviewed({ ...pr, prNumber: 1 }, { summaryCommentId: 1 });
    store.markPending({ ...pr, prNumber: 101 });

    expect(store.list()).toHaveLength(100);
    expect(store.get({ ...pr, prNumber: 1 })).toBeDefined();
    expect(store.get({ ...pr, prNumber: 2 })).toBeUndefined();
    expect(store.get({ ...pr, prNumber: 101 })).toBeDefined();
  });
});
