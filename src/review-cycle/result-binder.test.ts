import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createReviewQueue, type ReviewQueue } from "../queue/review-queue.js";
import { createReviewStatusStore, type ReviewStatusStore } from "../queue/review-status.js";
import { buildMarker } from "./correlation.js";
import { ContractError } from "./errors.js";
import { type LedgerAccept, ReviewCycleLedger } from "./ledger.js";
import { ResultBinder } from "./result-binder.js";
import { createFakeGithub, type FakeGithub } from "./testing/fake-github.js";

const CYCLE = "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1";
const CANCEL = "cxl_01jbq3x8n5r7t9v2w4y6z8a0e1";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "89abcdef0123456789abcdef0123456789abcdef";
const pr = { owner: "org", repo: "repo", prNumber: 5 };
const COMMENT_URL = "https://github.com/org/repo/pull/5#issuecomment-";
const REVIEW_URL = "https://github.com/org/repo/pull/5#pullrequestreview-";
const accept: LedgerAccept = {
  cycleId: CYCLE,
  round: 1,
  ...pr,
  headSha: HEAD,
  reason: "opened",
  sourceId: null,
  installationId: 1,
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let ledger: ReviewCycleLedger;
let queue: ReviewQueue;
let reviewStatus: ReviewStatusStore;
let github: FakeGithub;
let binder: ResultBinder;
let candidateId: string;
let writeCounter = 0;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ContractError) return error.code;
    throw error;
  }
  throw new Error("契約エラーが投げられなかった");
}

type PostRequest = Parameters<ResultBinder["post"]>[0];

function request(overrides: Partial<PostRequest> = {}): PostRequest {
  return {
    candidateId,
    pr,
    headSha: HEAD,
    kind: "reviewed",
    write: async () => ({ id: 9001, url: `${COMMENT_URL}9001` }),
    ...overrides,
  };
}

function botPost(
  id: number,
  body: string,
  login = "thread-owl[bot]",
  kind: "comment" | "review" = "comment",
) {
  github.posts.push({ kind, id, body, login, createdAt: "2026-10-25T00:30:00Z" });
}

beforeEach(() => {
  writeCounter = 0;
  queue = createReviewQueue();
  reviewStatus = createReviewStatusStore();
  github = createFakeGithub();
  ledger = new ReviewCycleLedger({
    path: ":memory:",
    now: () => new Date("2026-10-25T00:00:00Z"),
    newWriteId: () => (++writeCounter).toString(16).padStart(16, "0"),
  });
  binder = new ResultBinder({
    ledger,
    queue,
    reviewStatus,
    getClient: async () => github.client,
    botLogin: "Thread-Owl[bot]",
    logger,
    now: () => new Date("2026-10-25T01:00:00Z"),
  });
  candidateId = ledger.accept(accept).candidateId;
  queue.enqueue({
    ...pr,
    installationId: 1,
    queuedAt: new Date(),
    reason: "opened",
    cycle: { candidateId, cycleId: CYCLE, round: 1, headSha: HEAD },
  });
  reviewStatus.markPending(pr);
  binder.noteStatusRound(CYCLE, pr);
});

afterEach(() => {
  ledger.close();
});

describe("post", () => {
  test("候補に束縛して投稿し、結果索引へ記録して、queue から外し、status を更新する", async () => {
    const write = vi.fn(async () => ({ id: 9001, url: `${COMMENT_URL}9001` }));
    const result = await binder.post(request({ write }));

    expect(result).toEqual({
      source: "thread-owl",
      kind: "reviewed",
      headSha: HEAD,
      resultVersion: 1,
      post: { commentId: 9001, url: `${COMMENT_URL}9001` },
    });
    // 本文に付けるマーカーは、この書込みの writeId と cycle・candidate・kind を含む
    expect(write).toHaveBeenCalledWith(
      buildMarker({ cycleId: CYCLE, candidateId, writeId: "0000000000000001", kind: "reviewed" }),
    );
    expect(queue.size()).toBe(0);
    expect(reviewStatus.get(pr)).toMatchObject({
      status: "reviewed",
      headSha: HEAD,
      summaryCommentId: 9001,
    });
    expect(ledger.pendingWriteByCycle(CYCLE)).toBeUndefined();
  });

  test("approved は status を approved にする", async () => {
    await binder.post(request({ kind: "approved" }));
    expect(reviewStatus.get(pr)).toMatchObject({ status: "approved", headSha: HEAD });
  });

  test("HEAD を省略した投稿は、候補の HEAD を使う", async () => {
    const result = await binder.post(request({ headSha: undefined }));
    expect(result.headSha).toBe(HEAD);
  });

  test.each<[string, Partial<PostRequest>, string]>([
    ["HEAD が候補と違う", { headSha: OTHER_HEAD }, "RESULT_HEAD_MISMATCH"],
    ["PR が候補と違う", { pr: { ...pr, prNumber: 6 } }, "INVALID_ARGUMENT"],
    ["repo が候補と違う", { pr: { ...pr, repo: "other" } }, "INVALID_ARGUMENT"],
    ["未知の候補", { candidateId: "cand_00000000000000000000009999" }, "REQUEST_NOT_FOUND"],
  ])("%s は投稿せずに拒否する", async (_name, override, code) => {
    const write = vi.fn();
    await expect(codeOf(binder.post(request({ ...override, write })))).resolves.toBe(code);
    expect(write).not.toHaveBeenCalled();
  });

  test("owner / repo の大文字小文字は区別しない", async () => {
    const result = await binder.post(request({ pr: { ...pr, owner: "ORG", repo: "Repo" } }));
    expect(result.resultVersion).toBe(1);
  });

  test("取消済みの候補には投稿させない", async () => {
    ledger.cancel({ cycleId: CYCLE, round: 1, headSha: HEAD, cancelId: CANCEL });
    const write = vi.fn();
    await expect(codeOf(binder.post(request({ write })))).resolves.toBe("CANDIDATE_CANCELLED");
    expect(write).not.toHaveBeenCalled();
  });

  test("同じ cycle の別の結果（summary の後に approve）は、版が増える", async () => {
    await binder.post(request());
    const second = await binder.post(
      request({ kind: "approved", write: async () => ({ id: 9002, url: `${REVIEW_URL}9002` }) }),
    );
    expect(second.resultVersion).toBe(2);
  });

  test("新しい受付（新しい status のラウンド）が入った後は、古い cycle の投稿で status を完了にしない", async () => {
    // 同じ PR に新しい cycle が受け付けられ、status が新しいラウンドの pending になった
    reviewStatus.markPending(pr);
    await binder.post(request());
    expect(reviewStatus.get(pr)?.status).toBe("pending");
  });

  test("並行する書込み（このプロセスで進行中）は始められない", async () => {
    let release: (post: { id: number; url: string }) => void = () => {};
    const first = binder.post(
      request({
        write: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      }),
    );
    await vi.waitFor(() => expect(ledger.pendingWriteByCycle(CYCLE)).toBeDefined());
    await expect(codeOf(binder.post(request()))).resolves.toBe("UNAVAILABLE");
    release({ id: 9001, url: `${COMMENT_URL}9001` });
    await first;
  });
});

describe("失敗・停止後の照合", () => {
  test("書込みが失敗したら進行中のまま残り、投稿が無ければ、次の投稿で解除して再投稿できる", async () => {
    await expect(
      binder.post(
        request({
          write: async () => {
            throw new Error("network");
          },
        }),
      ),
    ).rejects.toThrow("network");
    expect(ledger.pendingWriteByCycle(CYCLE)).toBeDefined();

    const write = vi.fn(async () => ({ id: 9100, url: `${COMMENT_URL}9100` }));
    const result = await binder.post(request({ write }));
    expect(write).toHaveBeenCalledOnce();
    expect(result.post.commentId).toBe(9100);
  });

  test("書込みは成功していた（記録前に停止した）場合、同じ種別の再試行は再投稿せず、その投稿を返す", async () => {
    let marker = "";
    await expect(
      binder.post(
        request({
          write: async (m) => {
            marker = m;
            throw new Error("crashed after post");
          },
        }),
      ),
    ).rejects.toThrow();
    botPost(9200, `本文\n\n${marker}`);

    const write = vi.fn();
    const result = await binder.post(request({ write }));
    expect(write).not.toHaveBeenCalled();
    expect(result.post).toEqual({ commentId: 9200, url: `${COMMENT_URL}9200` });
    expect(reviewStatus.get(pr)).toMatchObject({ status: "reviewed", summaryCommentId: 9200 });
  });

  test("見つかった投稿と違う種別の投稿は、記録した上で、新しく書く", async () => {
    let marker = "";
    await expect(
      binder.post(
        request({
          write: async (m) => {
            marker = m;
            throw new Error("crashed");
          },
        }),
      ),
    ).rejects.toThrow();
    botPost(9300, marker);

    const result = await binder.post(
      request({ kind: "approved", write: async () => ({ id: 9301, url: `${REVIEW_URL}9301` }) }),
    );
    expect(result).toMatchObject({ kind: "approved", resultVersion: 2 });
    expect(ledger.getResult(CYCLE, candidateId)?.resultVersion).toBe(2);
  });
});

describe("reconcileStale", () => {
  function stalePending(kind: "reviewed" | "approved"): string {
    const begun = ledger.beginResultWrite(candidateId, kind);
    return buildMarker({ cycleId: CYCLE, candidateId, writeId: begun.writeId, kind });
  }

  test("進行中の書込みが無ければ何もしない", async () => {
    await expect(binder.reconcileStale(CYCLE)).resolves.toBeUndefined();
  });

  test.each([
    ["reviewed", "comment", "issuecomment"],
    ["approved", "review", "pullrequestreview"],
  ] as const)(
    "%s は GitHub の %s から照合し、見つかった投稿を記録する",
    async (kind, listed, fragment) => {
      const marker = stalePending(kind);
      botPost(7777, marker, "thread-owl[bot]", listed);
      const recovered = await binder.reconcileStale(CYCLE);
      expect(recovered?.post.url).toBe(`https://github.com/org/repo/pull/5#${fragment}-7777`);
      expect(ledger.pendingWriteByCycle(CYCLE)).toBeUndefined();
    },
  );

  test.each<[string, (marker: string) => string, string]>([
    [
      "別の writeId",
      (m) => m.replace(/writeId=[0-9a-f]{16}/, "writeId=ffffffffffffffff"),
      "thread-owl[bot]",
    ],
    ["別の cycle", (m) => m.replace(CYCLE, "cyc_01jbq3x8n5r7t9v2w4y6z8a0c9"), "thread-owl[bot]"],
    ["別の kind", (m) => m.replace("kind=reviewed", "kind=approved"), "thread-owl[bot]"],
    ["bot 以外の投稿者", (m) => m, "mallory"],
  ])("一致しないマーカー（%s）は信用せず、書込みを解除する", async (_name, tamper, login) => {
    const marker = stalePending("reviewed");
    botPost(7778, tamper(marker), login);
    await expect(binder.reconcileStale(CYCLE)).resolves.toBeUndefined();
    expect(ledger.pendingWriteByCycle(CYCLE)).toBeUndefined();
    expect(ledger.getResult(CYCLE, candidateId)).toBeNull();
  });

  test("GitHub を読めなければ例外のまま伝播し、書込みは進行中のまま残る", async () => {
    stalePending("reviewed");
    github.failing = true;
    await expect(binder.reconcileStale(CYCLE)).rejects.toThrow();
    expect(ledger.pendingWriteByCycle(CYCLE)).toBeDefined();
  });
});
