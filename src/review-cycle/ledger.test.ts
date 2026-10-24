import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { validateContract } from "../contract/validate.js";
import { ContractError, type ContractErrorCode } from "./errors.js";
import {
  type CancelInput,
  type LedgerAccept,
  type ResultPost,
  ReviewCycleLedger,
} from "./ledger.js";

const CYCLE = "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1";
const CANCEL = "cxl_01jbq3x8n5r7t9v2w4y6z8a0e1";
const HEAD_A = "0123456789abcdef0123456789abcdef01234567";
const HEAD_B = "89abcdef0123456789abcdef0123456789abcdef";

const accept: LedgerAccept = {
  installationId: 42,
  cycleId: CYCLE,
  round: 1,
  owner: "scottlz0310",
  repo: "mcp-resource-subscriber",
  prNumber: 226,
  headSha: HEAD_A,
  reason: "opened",
  sourceId: null,
};

const cancel: CancelInput = { cycleId: CYCLE, round: 1, headSha: HEAD_A, cancelId: CANCEL };

const posted: ResultPost = {
  kind: "approved",
  headSha: HEAD_A,
  post: {
    commentId: 6000001,
    url: "https://github.com/scottlz0310/mcp-resource-subscriber/pull/226#issuecomment-6000001",
  },
  postedAt: "2026-10-25T00:00:00Z",
};

function codeOf(fn: () => unknown): ContractErrorCode {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContractError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("契約エラーが投げられなかった");
}

let ledger: ReviewCycleLedger;
let sequence = 0;

function open(path = ":memory:"): ReviewCycleLedger {
  return new ReviewCycleLedger({
    path,
    now: () => new Date("2026-10-25T00:00:00Z"),
    newCandidateId: () => `cand_${String(++sequence).padStart(26, "0")}`,
  });
}

beforeEach(() => {
  sequence = 0;
  ledger = open();
});

afterEach(() => {
  ledger.close();
});

describe("accept", () => {
  test("候補を受け付け、契約の出力 schema に適合する", () => {
    const out = ledger.accept(accept);
    expect(out).toEqual({ candidateId: "cand_00000000000000000000000001", duplicate: false });
    expect(
      validateContract("accept_review_candidate.output", { schemaVersion: 1, ...out }),
    ).toEqual({
      ok: true,
    });
  });

  test("candidateId の既定の生成は契約の書式に従う", () => {
    const real = new ReviewCycleLedger({ path: ":memory:" });
    try {
      expect(real.accept(accept).candidateId).toMatch(/^cand_[0-9a-z]{26}$/);
    } finally {
      real.close();
    }
  });

  test("同じ cycle の同一内容の再送は同じ candidateId を返す", () => {
    const first = ledger.accept(accept);
    expect(ledger.accept(accept)).toEqual({ candidateId: first.candidateId, duplicate: true });
  });

  test.each<[string, Partial<LedgerAccept>, ContractErrorCode]>([
    ["HEAD が違う", { headSha: HEAD_B }, "HEAD_CONFLICT"],
    ["round が違う", { round: 2 }, "INVALID_ARGUMENT"],
    ["PR が違う", { prNumber: 227 }, "INVALID_ARGUMENT"],
    ["reason が違う", { reason: "synchronized" }, "INVALID_ARGUMENT"],
    ["sourceId が違う", { sourceId: "delivery:0f1e2d3c-0001" }, "INVALID_ARGUMENT"],
  ])("同じ cycle に内容の違う候補は受け付けない（%s）", (_name, change, code) => {
    ledger.accept(accept);
    expect(codeOf(() => ledger.accept({ ...accept, ...change }))).toBe(code);
  });
});

describe("start", () => {
  test("cycle・round・HEAD を束縛して返し、再実行しても同じ", () => {
    const { candidateId } = ledger.accept(accept);
    const binding = {
      candidateId,
      cycleId: CYCLE,
      round: 1,
      owner: "scottlz0310",
      repo: "mcp-resource-subscriber",
      prNumber: 226,
      headSha: HEAD_A,
    };
    expect(ledger.start(candidateId)).toEqual(binding);
    expect(ledger.start(candidateId)).toEqual(binding);
  });

  test("未知の候補は REQUEST_NOT_FOUND", () => {
    expect(codeOf(() => ledger.start("cand_00000000000000000000009999"))).toBe("REQUEST_NOT_FOUND");
  });

  test("取消済みの候補は起動しない", () => {
    const { candidateId } = ledger.accept(accept);
    ledger.cancel(cancel);
    expect(codeOf(() => ledger.start(candidateId))).toBe("CANDIDATE_CANCELLED");
  });
});

describe("cancel", () => {
  test("受付より先着した取消は未受理 cycle に永続し、後から来た受付を拒否する", () => {
    const out = ledger.cancel(cancel);
    expect(out).toEqual({ cancelId: CANCEL, candidateStatus: "not-accepted" });
    expect(
      validateContract("cancel_review_candidate.output", {
        schemaVersion: 1,
        ...out,
        acknowledged: true,
        githubWriteReconciled: true,
      }),
    ).toEqual({ ok: true });
    expect(codeOf(() => ledger.accept(accept))).toBe("CANDIDATE_CANCELLED");
  });

  test.each([
    ["queued", false],
    ["started", true],
  ] as const)("受理済みの候補（%s）の取消は状態を返し、起動・投稿を拒否する", (status, started) => {
    const { candidateId } = ledger.accept(accept);
    if (started) {
      ledger.start(candidateId);
    }
    expect(ledger.cancel(cancel)).toEqual({ cancelId: CANCEL, candidateStatus: status });
    expect(codeOf(() => ledger.start(candidateId))).toBe("CANDIDATE_CANCELLED");
    expect(codeOf(() => ledger.beginResultWrite(candidateId))).toBe("CANDIDATE_CANCELLED");
  });

  test("同じ取消の再送は冪等で、取消後は同じ受付の再送も拒否する", () => {
    ledger.accept(accept);
    ledger.cancel(cancel);
    expect(ledger.cancel(cancel).cancelId).toBe(CANCEL);
    expect(codeOf(() => ledger.accept(accept))).toBe("CANDIDATE_CANCELLED");
  });

  test.each<[string, Partial<CancelInput>, ContractErrorCode]>([
    ["HEAD が違う", { headSha: HEAD_B }, "HEAD_CONFLICT"],
    ["round が違う", { round: 2 }, "INVALID_ARGUMENT"],
  ])("受理済みの候補と食い違う取消は拒否する（%s）", (_name, change, code) => {
    ledger.accept(accept);
    expect(codeOf(() => ledger.cancel({ ...cancel, ...change }))).toBe(code);
  });

  test("取消記録と HEAD が違う取消は HEAD_CONFLICT", () => {
    ledger.cancel(cancel);
    expect(codeOf(() => ledger.cancel({ ...cancel, headSha: HEAD_B }))).toBe("HEAD_CONFLICT");
  });

  test("結果の投稿が先に確定していれば CANCEL_RESULT_POSTED で、結果は取り消さない", () => {
    const { candidateId } = ledger.accept(accept);
    ledger.beginResultWrite(candidateId);
    ledger.recordResultPosted(candidateId, posted);
    expect(codeOf(() => ledger.cancel(cancel))).toBe("CANCEL_RESULT_POSTED");
    expect(ledger.getResult(CYCLE, candidateId)?.resultVersion).toBe(1);
    // 取消記録は残らないので、受付の再送は引き続き受理される
    expect(ledger.accept(accept).duplicate).toBe(true);
  });

  describe("GitHub 書込みの進行中", () => {
    test("照合前は ACK せず、取消記録を残して起動と新規投稿を拒否する", () => {
      const { candidateId } = ledger.accept(accept);
      ledger.beginResultWrite(candidateId);
      expect(codeOf(() => ledger.cancel(cancel))).toBe("CANCEL_UNCONFIRMED");
      expect(codeOf(() => ledger.cancel(cancel))).toBe("CANCEL_UNCONFIRMED");
      expect(codeOf(() => ledger.start(candidateId))).toBe("CANDIDATE_CANCELLED");
      expect(codeOf(() => ledger.beginResultWrite(candidateId))).toBe("CANDIDATE_CANCELLED");
    });

    test("投稿の実在が照合できれば CANCEL_RESULT_POSTED になり、要求中の取消は撤回される", () => {
      const { candidateId } = ledger.accept(accept);
      ledger.beginResultWrite(candidateId);
      expect(codeOf(() => ledger.cancel(cancel))).toBe("CANCEL_UNCONFIRMED");
      ledger.recordResultPosted(candidateId, posted);
      expect(codeOf(() => ledger.cancel(cancel))).toBe("CANCEL_RESULT_POSTED");
      expect(ledger.accept(accept).duplicate).toBe(true);
    });

    test("投稿が無いと照合できれば、同じ取消 ID の再試行で確定する", () => {
      const { candidateId } = ledger.accept(accept);
      ledger.beginResultWrite(candidateId);
      expect(codeOf(() => ledger.cancel(cancel))).toBe("CANCEL_UNCONFIRMED");
      ledger.abortResultWrite(candidateId);
      expect(ledger.cancel(cancel)).toEqual({ cancelId: CANCEL, candidateStatus: "queued" });
      expect(codeOf(() => ledger.accept(accept))).toBe("CANDIDATE_CANCELLED");
    });
  });
});

describe("結果の索引", () => {
  test("投稿の前は null で、投稿後は版つきの参照を返し、契約の出力 schema に適合する", () => {
    const { candidateId } = ledger.accept(accept);
    expect(ledger.getResult(CYCLE, candidateId)).toBeNull();
    ledger.beginResultWrite(candidateId);
    const recorded = ledger.recordResultPosted(candidateId, posted);
    expect(recorded).toEqual({
      source: "thread-owl",
      kind: "approved",
      headSha: HEAD_A,
      resultVersion: 1,
      post: posted.post,
    });
    const out = { schemaVersion: 1, result: ledger.getResult(CYCLE, candidateId) };
    expect(validateContract("get_review_result.output", out)).toEqual({ ok: true });
    expect(
      validateContract("get_review_result.output", { schemaVersion: 1, result: null }),
    ).toEqual({
      ok: true,
    });
  });

  test("同じ投稿の再記録は同じ版を返し、別の投稿は版が増える", () => {
    const { candidateId } = ledger.accept(accept);
    ledger.beginResultWrite(candidateId);
    expect(ledger.recordResultPosted(candidateId, posted).resultVersion).toBe(1);
    expect(ledger.recordResultPosted(candidateId, posted).resultVersion).toBe(1);
    const second = {
      ...posted,
      kind: "reviewed" as const,
      post: { ...posted.post, commentId: 6000002 },
    };
    expect(ledger.recordResultPosted(candidateId, second).resultVersion).toBe(2);
    expect(ledger.getResult(CYCLE, candidateId)?.kind).toBe("reviewed");
  });

  test("候補の HEAD と違う結果は記録しない", () => {
    const { candidateId } = ledger.accept(accept);
    ledger.beginResultWrite(candidateId);
    expect(
      codeOf(() => ledger.recordResultPosted(candidateId, { ...posted, headSha: HEAD_B })),
    ).toBe("RESULT_HEAD_MISMATCH");
  });

  test("cycle と candidate の組が違えば REQUEST_NOT_FOUND", () => {
    const { candidateId } = ledger.accept(accept);
    expect(codeOf(() => ledger.getResult("cyc_01jbq3x8n5r7t9v2w4y6z8a0c9", candidateId))).toBe(
      "REQUEST_NOT_FOUND",
    );
    expect(codeOf(() => ledger.getResult(CYCLE, "cand_00000000000000000000009999"))).toBe(
      "REQUEST_NOT_FOUND",
    );
  });

  test("書込みの進行中に、もう一度始めることはできない", () => {
    const { candidateId } = ledger.accept(accept);
    ledger.beginResultWrite(candidateId);
    expect(codeOf(() => ledger.beginResultWrite(candidateId))).toBe("UNAVAILABLE");
  });

  test("未知の候補への操作は REQUEST_NOT_FOUND", () => {
    const unknown = "cand_00000000000000000000009999";
    expect(codeOf(() => ledger.beginResultWrite(unknown))).toBe("REQUEST_NOT_FOUND");
    expect(codeOf(() => ledger.recordResultPosted(unknown, posted))).toBe("REQUEST_NOT_FOUND");
    expect(codeOf(() => ledger.abortResultWrite(unknown))).toBe("REQUEST_NOT_FOUND");
  });
});

describe("再起動をまたぐ永続", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "owl-ledger-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("受付・取消記録・結果索引が再起動後も残る", () => {
    const path = join(dir, "ledger.sqlite");
    const first = open(path);
    const { candidateId } = first.accept(accept);
    first.beginResultWrite(candidateId);
    first.recordResultPosted(candidateId, posted);
    first.cancel({ ...cancel, cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c2" });
    first.close();

    const second = open(path);
    try {
      expect(second.accept(accept)).toEqual({ candidateId, duplicate: true });
      expect(second.getResult(CYCLE, candidateId)?.post).toEqual(posted.post);
      expect(
        codeOf(() => second.accept({ ...accept, cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c2" })),
      ).toBe("CANDIDATE_CANCELLED");
      expect(codeOf(() => second.cancel(cancel))).toBe("CANCEL_RESULT_POSTED");
    } finally {
      second.close();
    }
  });

  test("書込みの進行中（結果不明）は再起動後も保持され、照合前に取消を確定しない", () => {
    const path = join(dir, "ledger.sqlite");
    const first = open(path);
    const { candidateId } = first.accept(accept);
    first.beginResultWrite(candidateId);
    first.close();

    const second = open(path);
    try {
      expect(codeOf(() => second.cancel(cancel))).toBe("CANCEL_UNCONFIRMED");
      second.abortResultWrite(candidateId);
      expect(second.cancel(cancel).candidateStatus).toBe("queued");
    } finally {
      second.close();
    }
  });
});

describe("listQueued", () => {
  test("未起動・未取消の候補を、受付順に installationId つきで返す", () => {
    const a = ledger.accept(accept);
    const b = ledger.accept({
      ...accept,
      cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c2",
      prNumber: 227,
      installationId: 43,
    });
    const c = ledger.accept({
      ...accept,
      cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c3",
      prNumber: 228,
    });
    ledger.accept({ ...accept, cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c4", prNumber: 229 });
    ledger.start(c.candidateId);
    ledger.cancel({
      cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c4",
      round: 1,
      headSha: HEAD_A,
      cancelId: CANCEL,
    });

    expect(
      ledger.listQueued().map((q) => [q.candidateId, q.prNumber, q.installationId, q.reason]),
    ).toEqual([
      [a.candidateId, 226, 42, "opened"],
      [b.candidateId, 227, 43, "opened"],
    ]);
  });
});
