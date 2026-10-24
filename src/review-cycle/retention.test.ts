import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createReviewQueue } from "../queue/review-queue.js";
import { abortableSleep } from "./abortable-sleep.js";
import { type LedgerAccept, ReviewCycleLedger } from "./ledger.js";
import { purgeOnce, runRetention } from "./retention.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const DAY = 86_400_000;
const T0 = new Date("2026-10-25T00:00:00Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let clock = T0;
let ledger: ReviewCycleLedger;

const cycleOf = (n: number) => `cyc_${String(n).padStart(26, "0")}`;
const cancelOf = (n: number) => `cxl_${String(n).padStart(26, "0")}`;

function acceptOf(n: number): LedgerAccept {
  return {
    cycleId: cycleOf(n),
    round: 1,
    owner: "org",
    repo: "repo",
    prNumber: 100 + n,
    headSha: HEAD,
    reason: "opened",
    sourceId: null,
    installationId: 1,
  };
}

function advance(days: number) {
  clock = new Date(clock.getTime() + days * DAY);
}

function post(candidateId: string, commentId: number) {
  ledger.recordResultPosted(candidateId, {
    kind: "reviewed",
    headSha: HEAD,
    post: { commentId, url: `https://github.com/org/repo/pull/101#issuecomment-${commentId}` },
    postedAt: clock.toISOString(),
  });
}

function cancel(n: number) {
  ledger.cancel({ cycleId: cycleOf(n), round: 1, headSha: HEAD, cancelId: cancelOf(n) });
}

const zero = {
  purgedCycleIds: [],
  candidates: 0,
  results: 0,
  cancellations: 0,
  resultOutbox: 0,
  ingestOutbox: 0,
};

beforeEach(() => {
  clock = T0;
  vi.clearAllMocks();
  ledger = new ReviewCycleLedger({ path: ":memory:", now: () => clock });
});

afterEach(() => {
  ledger.close();
});

describe("purgeExpired", () => {
  test("期限内の行は何も削除しない", () => {
    const { candidateId } = ledger.accept(acceptOf(1));
    post(candidateId, 1);
    cancel(2);
    ledger.enqueueIngest({
      sourceId: "delivery:a",
      owner: "org",
      repo: "repo",
      prNumber: 1,
      headSha: HEAD,
      reason: "opened",
      delivery: "webhook",
    });
    advance(29);
    expect(ledger.purgeExpired(30)).toEqual(zero);
  });

  test("期限を過ぎた結果索引と、送り終えた通知を削除する（送信待ちは残す）", () => {
    const sent = ledger.accept(acceptOf(1)).candidateId;
    post(sent, 1);
    ledger.markResultDelivered(cycleOf(1), 1);
    const waiting = ledger.accept(acceptOf(2)).candidateId;
    post(waiting, 2);
    ledger.enqueueIngest({
      sourceId: "delivery:done",
      owner: "org",
      repo: "repo",
      prNumber: 1,
      headSha: HEAD,
      reason: "opened",
      delivery: "webhook",
    });
    ledger.markIngestDelivered("delivery:done");
    ledger.enqueueIngest({
      sourceId: "delivery:waiting",
      owner: "org",
      repo: "repo",
      prNumber: 2,
      headSha: HEAD,
      reason: "opened",
      delivery: "webhook",
    });

    advance(31);
    const report = ledger.purgeExpired(30);
    expect(report).toMatchObject({ results: 2, resultOutbox: 1, ingestOutbox: 1 });
    // 送信待ちは、期限を過ぎても残る
    expect(ledger.dueResultMessages().map((d) => d.message.cycleId)).toEqual([cycleOf(2)]);
    expect(ledger.dueIngestMessages().map((d) => d.message.sourceId)).toEqual(["delivery:waiting"]);
    // 結果索引も候補も期限を過ぎたので、引くと「見つからない」
    expect(() => ledger.getResult(cycleOf(1), sent)).toThrowError(
      expect.objectContaining({ code: "REQUEST_NOT_FOUND" }),
    );
  });

  test("取消記録は、確定した時刻から数える（受付より先に確定していても、遅れて作られた記録を早く消さない）", () => {
    cancel(1); // 時刻 T0 に確定
    advance(20);
    cancel(2); // 時刻 T0+20 日に確定
    advance(11); // T0+31 日: 1 件目は期限切れ、2 件目は 11 日経過
    expect(ledger.purgeExpired(30).cancellations).toBe(1);
    // 2 件目は残り、旧受付を拒否し続ける。1 件目は消えたので、受付できる（失効として扱う）
    expect(() => ledger.accept(acceptOf(2))).toThrowError(
      expect.objectContaining({ code: "CANDIDATE_CANCELLED" }),
    );
    expect(ledger.accept(acceptOf(1)).duplicate).toBe(false);
  });

  test("要求から確定まで間があった取消は、要求の時刻ではなく、確定した時刻から数える", () => {
    const { candidateId } = ledger.accept(acceptOf(1));
    const { writeId } = ledger.beginResultWrite(candidateId, "reviewed");
    expect(() => cancel(1)).toThrowError(expect.objectContaining({ code: "CANCEL_UNCONFIRMED" })); // T0 に要求
    advance(25);
    ledger.abortResultWrite(candidateId, writeId);
    cancel(1); // T0+25 日に確定
    advance(10); // T0+35 日: 要求からは 35 日だが、確定からは 10 日
    expect(ledger.purgeExpired(30).cancellations).toBe(0);
    expect(() => ledger.start(candidateId)).toThrowError(
      expect.objectContaining({ code: "CANDIDATE_CANCELLED" }),
    );
    advance(21); // 確定から 31 日
    expect(ledger.purgeExpired(30).cancellations).toBe(1);
  });

  test("要求中（未確定）の取消は、期限を過ぎても削除しない", () => {
    const { candidateId } = ledger.accept(acceptOf(1));
    ledger.beginResultWrite(candidateId, "reviewed");
    expect(() => cancel(1)).toThrowError(expect.objectContaining({ code: "CANCEL_UNCONFIRMED" }));
    advance(365);
    expect(ledger.purgeExpired(30).cancellations).toBe(0);
    // 旧候補の起動・投稿は、拒否され続ける
    expect(() => ledger.start(candidateId)).toThrowError(
      expect.objectContaining({ code: "CANDIDATE_CANCELLED" }),
    );
  });

  test("候補は、書込みが進行中、または送信待ちの通知がある間は削除しない（結果・取消記録が期限切れで消えた分は削除する）", () => {
    const withResult = ledger.accept(acceptOf(1)).candidateId;
    post(withResult, 1);
    const cancelled = ledger.accept(acceptOf(2)).candidateId;
    cancel(2);
    const writing = ledger.accept(acceptOf(3)).candidateId;
    ledger.beginResultWrite(writing, "reviewed");
    ledger.accept(acceptOf(4)); // 何も残らない（結果なし・取消なし・書込みなし）

    advance(31);
    // 結果の通知が送信待ちの間は、その結果の候補を残す
    expect(ledger.purgeExpired(30).candidates).toBe(2); // cycle 2（取消記録が期限切れ）と cycle 4
    expect(ledger.getCandidate(writing)).toBeDefined();
    expect(ledger.getCandidate(withResult)).toBeDefined(); // 結果の通知が送信待ちなので残る
    expect(ledger.getCandidate(cancelled)).toBeUndefined();

    // 通知を送り終えれば、次の周期で削除される
    ledger.markResultDelivered(cycleOf(1), 1);
    advance(31);
    expect(ledger.purgeExpired(30).candidates).toBe(1);
    expect(ledger.getCandidate(withResult)).toBeUndefined();
    expect(ledger.getCandidate(writing)).toBeDefined(); // 書込みが進行中のものは残り続ける
  });

  test("取消記録が期限切れで消えた周期に、同じ候補も削除される", () => {
    const cancelled = ledger.accept(acceptOf(2)).candidateId;
    cancel(2);
    advance(31);
    ledger.purgeExpired(30);
    expect(ledger.getCandidate(cancelled)).toBeUndefined();
  });

  test("保持期間を延ばせば、その分だけ残る", () => {
    const { candidateId } = ledger.accept(acceptOf(1));
    post(candidateId, 1);
    advance(45);
    expect(ledger.purgeExpired(60)).toEqual(zero);
    advance(20);
    expect(ledger.purgeExpired(60).results).toBe(1);
  });
});

describe("結果の版の採番（保持期限の削除の後も単調増加）", () => {
  test("結果索引だけが削除されても、残っている通知の版と衝突せず、次の結果は次の版になる", () => {
    const { candidateId } = ledger.accept(acceptOf(1));
    post(candidateId, 1); // 版 1。通知は送信待ちのまま残す
    advance(31);
    const { writeId } = ledger.beginResultWrite(candidateId, "approved");
    // 結果索引（版 1）は期限切れで削除されるが、候補（書込みが進行中）と送信待ちの通知は残る
    expect(ledger.purgeExpired(30)).toMatchObject({ results: 1, candidates: 0 });
    expect(ledger.dueResultMessages().map((d) => d.message.resultVersion)).toEqual([1]);

    const second = ledger.recordResultPosted(candidateId, {
      kind: "approved",
      headSha: HEAD,
      post: { commentId: 2, url: "https://github.com/org/repo/pull/101#issuecomment-2" },
      postedAt: clock.toISOString(),
      writeId,
    });
    expect(second.resultVersion).toBe(2);
    expect(ledger.dueResultMessages().map((d) => d.message.resultVersion)).toEqual([1, 2]);
  });

  test("版は候補ごとに独立して採番される", () => {
    const a = ledger.accept(acceptOf(1)).candidateId;
    const b = ledger.accept(acceptOf(2)).candidateId;
    post(a, 1);
    post(a, 2);
    post(b, 3);
    expect(ledger.getResult(cycleOf(1), a)?.resultVersion).toBe(2);
    expect(ledger.getResult(cycleOf(2), b)?.resultVersion).toBe(1);
  });
});

describe("削除した候補と配信対象（queue）の同期", () => {
  test("purgeOnce は、削除した候補の cycleId を onPurged に渡す", () => {
    ledger.accept(acceptOf(1));
    ledger.accept(acceptOf(2));
    post(
      ledger.getCandidate(ledger.findByCycle(cycleOf(2))?.candidateId ?? "")?.candidateId ?? "",
      9,
    );
    advance(31);
    const onPurged = vi.fn();
    purgeOnce({ ledger, retentionDays: 30, logger, onPurged });
    expect(onPurged).toHaveBeenCalledWith(expect.arrayContaining([cycleOf(1)]));
    expect(onPurged.mock.calls[0][0]).toHaveLength(1);
  });

  test("削除がなければ onPurged を呼ばない", () => {
    ledger.accept(acceptOf(1));
    const onPurged = vi.fn();
    purgeOnce({ ledger, retentionDays: 30, logger, onPurged });
    expect(onPurged).not.toHaveBeenCalled();
  });

  test("定期削除でも、削除した cycle が queue に残らない", async () => {
    const { candidateId } = ledger.accept(acceptOf(1));
    const queue = createReviewQueue();
    queue.enqueue({
      owner: "org",
      repo: "repo",
      prNumber: 101,
      installationId: 1,
      queuedAt: clock,
      reason: "opened",
      cycle: { candidateId, cycleId: cycleOf(1), round: 1, headSha: HEAD },
    });
    advance(31);
    const controller = new AbortController();
    const loop = runRetention(
      {
        ledger,
        retentionDays: 30,
        logger,
        onPurged: (ids) => {
          for (const id of ids) queue.removeCycle(id);
        },
      },
      controller.signal,
      5,
    );
    await vi.waitFor(() => expect(queue.size()).toBe(0));
    controller.abort();
    await loop;
  });
});

describe("runRetention", () => {
  test("起動時に削除し、削除があればログに残し、中断で止まる", async () => {
    const { candidateId } = ledger.accept(acceptOf(1));
    post(candidateId, 1);
    advance(31);
    const controller = new AbortController();
    const loop = runRetention({ ledger, retentionDays: 30, logger }, controller.signal, 5);
    await vi.waitFor(() =>
      expect(logger.info).toHaveBeenCalledWith(
        "internal.retention.purged",
        expect.objectContaining({ results: 1 }),
      ),
    );
    controller.abort();
    await loop;
  });

  test("削除の失敗はログに残して止まらず、次の周期で再試行する", async () => {
    const purge = vi.spyOn(ledger, "purgeExpired").mockImplementationOnce(() => {
      throw new Error("db locked");
    });
    const controller = new AbortController();
    const loop = runRetention({ ledger, retentionDays: 30, logger }, controller.signal, 5);
    await vi.waitFor(() => expect(purge.mock.calls.length).toBeGreaterThanOrEqual(2));
    controller.abort();
    await loop;
    expect(logger.error).toHaveBeenCalledWith(
      "internal.retention.error",
      expect.objectContaining({ errorName: "Error" }),
    );
  });

  test("すでに中断されていれば、何もしない", async () => {
    const purge = vi.spyOn(ledger, "purgeExpired");
    const controller = new AbortController();
    controller.abort();
    await runRetention({ ledger, retentionDays: 30, logger }, controller.signal, 5);
    expect(purge).not.toHaveBeenCalled();
  });
});

describe("abortableSleep", () => {
  test("満了でも中断でも listener を残さず、中断済みなら待たない", async () => {
    const controller = new AbortController();
    await abortableSleep(2, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    const pending = abortableSleep(3_600_000, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await pending;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    await expect(abortableSleep(3_600_000, controller.signal)).resolves.toBeUndefined();
  });
});
