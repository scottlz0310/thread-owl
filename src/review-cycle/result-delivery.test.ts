import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContractError, type ContractErrorCode } from "./errors.js";
import { type LedgerAccept, type ResultMessage, ReviewCycleLedger } from "./ledger.js";
import {
  backoffMs,
  DEFAULT_DELIVERY_SETTINGS,
  deliverDue,
  type ResultPublisher,
  runDelivery,
} from "./result-delivery.js";

const CYCLE = "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const accept: LedgerAccept = {
  cycleId: CYCLE,
  round: 1,
  owner: "org",
  repo: "repo",
  prNumber: 5,
  headSha: HEAD,
  reason: "opened",
  sourceId: null,
  installationId: 1,
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

let clock = new Date("2026-10-25T00:00:00Z");
let ledger: ReviewCycleLedger;
let candidateId: string;

function record(commentId: number, kind: "reviewed" | "approved" = "reviewed") {
  return ledger.recordResultPosted(candidateId, {
    kind,
    headSha: HEAD,
    post: { commentId, url: `https://github.com/org/repo/pull/5#issuecomment-${commentId}` },
    postedAt: "2026-10-24T23:59:00Z",
  });
}

function publisherThatThrows(error: unknown): ResultPublisher & { calls: ResultMessage[] } {
  const calls: ResultMessage[] = [];
  return {
    calls,
    publish: async (message) => {
      calls.push(message);
      throw error;
    },
  };
}

function deps(publisher: ResultPublisher, random = () => 0.5) {
  return { ledger, publisher, logger, now: () => clock, random };
}

beforeEach(() => {
  clock = new Date("2026-10-25T00:00:00Z");
  vi.clearAllMocks();
  ledger = new ReviewCycleLedger({ path: ":memory:", now: () => clock });
  candidateId = ledger.accept(accept).candidateId;
});

afterEach(() => {
  ledger.close();
});

describe("outbox への積み込み", () => {
  test("結果の記録と同じタイミングで 1 件積まれ、同じ投稿の再記録では増えない", () => {
    expect(ledger.dueResultMessages()).toEqual([]);
    record(100);
    record(100);
    const due = ledger.dueResultMessages();
    expect(due).toHaveLength(1);
    expect(due[0]).toEqual({
      attempts: 0,
      message: {
        cycleId: CYCLE,
        candidateId,
        headSha: HEAD,
        resultVersion: 1,
        kind: "reviewed",
        post: { commentId: 100, url: "https://github.com/org/repo/pull/5#issuecomment-100" },
        postedAt: "2026-10-24T23:59:00Z",
      },
    });
  });

  test("別の投稿は別の版として積まれる", () => {
    record(100);
    record(101, "approved");
    expect(ledger.dueResultMessages().map((d) => d.message.resultVersion)).toEqual([1, 2]);
  });
});

describe("deliverDue", () => {
  test("送れた通知は delivered になり、もう積まれない", async () => {
    record(100);
    const sent: ResultMessage[] = [];
    const report = await deliverDue(deps({ publish: async (m) => void sent.push(m) }));
    expect(report).toEqual({ delivered: 1, retried: 0, rejected: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(ledger.dueResultMessages()).toEqual([]);
    expect((await deliverDue(deps({ publish: async () => {} }))).delivered).toBe(0);
  });

  test.each<ContractErrorCode>([
    "CANDIDATE_CANCELLED",
    "DELIVERY_EXPIRED",
    "RESULT_VERSION_STALE",
    "RESULT_HEAD_MISMATCH",
    "PERMISSION_DENIED",
    "INVALID_ARGUMENT",
    "REQUEST_NOT_FOUND",
  ])("再送しても通らない拒否（%s）は rejected で、再送しない", async (code) => {
    record(100);
    const publisher = publisherThatThrows(new ContractError(code, "rejected"));
    const report = await deliverDue(deps(publisher));
    expect(report).toEqual({ delivered: 0, retried: 0, rejected: 1, failed: 0 });
    clock = new Date(clock.getTime() + 3_600_000);
    await deliverDue(deps(publisher));
    expect(publisher.calls).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "internal.result.delivery.rejected",
      expect.objectContaining({ code }),
    );
  });

  test("ACK 未受信などの再送可能な失敗は、バックオフを置いて再送し、期限前には送らない", async () => {
    record(100);
    const publisher = publisherThatThrows(new ContractError("UNAVAILABLE", "down"));
    expect((await deliverDue(deps(publisher))).retried).toBe(1);
    // 1 回目の失敗の後は 1000ms（ジッタの乱数 0.5 は中央値）
    await deliverDue(deps(publisher));
    expect(publisher.calls).toHaveLength(1);
    clock = new Date(clock.getTime() + 999);
    await deliverDue(deps(publisher));
    expect(publisher.calls).toHaveLength(1);
    clock = new Date(clock.getTime() + 1);
    await deliverDue(deps(publisher));
    expect(publisher.calls).toHaveLength(2);
  });

  test("ContractError 以外の想定外の例外も、再送可能な失敗として扱う", async () => {
    record(100);
    const report = await deliverDue(deps(publisherThatThrows(new TypeError("boom"))));
    expect(report.retried).toBe(1);
  });

  test("試行上限に達したら failed にして諦める（別の経路へ切り替えない）", async () => {
    record(100);
    const publisher = publisherThatThrows(new ContractError("UNAVAILABLE", "down"));
    const settings = { ...DEFAULT_DELIVERY_SETTINGS, maxAttempts: 3 };
    const reports = [];
    for (let i = 0; i < 4; i++) {
      reports.push(await deliverDue({ ...deps(publisher), settings }));
      clock = new Date(clock.getTime() + 600_000);
    }
    expect(reports.map((r) => [r.retried, r.failed])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 0],
    ]);
    expect(publisher.calls).toHaveLength(3);
    expect(logger.error).toHaveBeenCalledWith(
      "internal.result.delivery.failed",
      expect.objectContaining({ attempts: 3 }),
    );
  });

  test("途中で成功すれば、以後は送らない", async () => {
    record(100);
    let fail = true;
    const publisher: ResultPublisher = {
      publish: async () => {
        if (fail) throw new ContractError("UNAVAILABLE", "down");
      },
    };
    await deliverDue(deps(publisher));
    fail = false;
    clock = new Date(clock.getTime() + 60_000);
    expect((await deliverDue(deps(publisher))).delivered).toBe(1);
    expect(ledger.dueResultMessages()).toEqual([]);
  });
});

describe("backoffMs", () => {
  test.each([
    [1, 0.5, 1000],
    [2, 0.5, 2000],
    [3, 0.5, 4000],
    [7, 0.5, 60000],
    [20, 0.5, 60000],
    [1, 0, 800],
    [1, 1, 1200],
    [7, 1, 72000],
  ])("%i 回目の失敗の後 (乱数 %f) は %i ms", (attempt, random, expected) => {
    expect(backoffMs(attempt, DEFAULT_DELIVERY_SETTINGS, random)).toBe(expected);
  });
});

describe("runDelivery", () => {
  test("周期ごとに配送し、中断されたら止まる", async () => {
    record(100);
    const sent: ResultMessage[] = [];
    const controller = new AbortController();
    const loop = runDelivery(
      deps({ publish: async (m) => void sent.push(m) }),
      5,
      controller.signal,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    controller.abort();
    await expect(loop).resolves.toBeUndefined();
  });

  test("台帳の失敗では止まらず、次の周期で再試行する", async () => {
    const failing = vi.spyOn(ledger, "dueResultMessages").mockImplementationOnce(() => {
      throw new Error("db locked");
    });
    const controller = new AbortController();
    const loop = runDelivery(deps({ publish: async () => {} }), 5, controller.signal);
    await vi.waitFor(() => expect(failing.mock.calls.length).toBeGreaterThanOrEqual(2));
    controller.abort();
    await loop;
    expect(logger.error).toHaveBeenCalledWith(
      "internal.result.delivery.error",
      expect.objectContaining({ errorName: "Error" }),
    );
  });
});
