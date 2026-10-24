import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Logger } from "../config/logging.js";
import { type ContractSchemaName, validateContract } from "../contract/validate.js";
import { createReviewQueue, type ReviewQueue } from "../queue/review-queue.js";
import { createReviewStatusStore, type ReviewStatusStore } from "../queue/review-status.js";
import {
  callInternalTool,
  INTERNAL_TOOLS,
  type InternalToolDeps,
  type InternalToolName,
  type ToolOutcome,
} from "./internal-tools.js";
import { ReviewCycleLedger } from "./ledger.js";
import type { OriginChecker } from "./origin.js";
import { parseServiceAcl } from "./service-acl.js";

const CYCLE = "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1";
const CYCLE_2 = "cyc_01jbq3x8n5r7t9v2w4y6z8a0c2";
const CANCEL = "cxl_01jbq3x8n5r7t9v2w4y6z8a0e1";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const acceptInput = {
  schemaVersion: 1,
  cycleId: CYCLE,
  round: 1,
  owner: "scottlz0310",
  repo: "mcp-resource-subscriber",
  prNumber: 226,
  headSha: HEAD,
  reason: "opened" as const,
  sourceId: null,
};
const cancelInput = { schemaVersion: 1, cycleId: CYCLE, round: 1, headSha: HEAD, cancelId: CANCEL };

const acl = parseServiceAcl(
  JSON.stringify({
    services: {
      "svc-raven": {
        actions: ["accept", "cancel", "get_result"],
        repos: ["scottlz0310/*"],
      },
      "svc-reader": { actions: ["get_result"], repos: ["scottlz0310/*"] },
      "svc-elsewhere": { actions: ["accept", "cancel", "get_result"], repos: ["someone-else/*"] },
    },
  }),
);

let ledger: ReviewCycleLedger;
let queue: ReviewQueue;
let reviewStatus: ReviewStatusStore;
let sequence = 0;
let originAnswer: Awaited<ReturnType<OriginChecker>> = { allowed: true };
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} satisfies Logger;

function deps(overrides: Partial<InternalToolDeps> = {}): InternalToolDeps {
  return {
    ledger,
    acl,
    checkOrigin: async () => originAnswer,
    queue,
    reviewStatus,
    resolveInstallationId: async () => 4242,
    logger,
    ...overrides,
  };
}

const outputSchema: Record<InternalToolName, ContractSchemaName> = {
  accept_review_candidate: "accept_review_candidate.output",
  cancel_review_candidate: "cancel_review_candidate.output",
  get_review_result: "get_review_result.output",
};

/** 結果が成功なら出力 schema、失敗ならエラー envelope の schema に適合することも確認する。 */
async function call(
  name: InternalToolName,
  input: unknown,
  principal = "svc-raven",
  d: InternalToolDeps = deps(),
): Promise<ToolOutcome> {
  const outcome = await callInternalTool(d, principal, name, input);
  expect(
    validateContract(
      outcome.ok ? outputSchema[name] : "error",
      outcome.ok ? outcome.output : outcome.envelope,
    ),
  ).toEqual({ ok: true });
  return outcome;
}

function errorCode(outcome: ToolOutcome): string {
  if (outcome.ok) {
    throw new Error("エラーが返るはずが成功した");
  }
  return outcome.envelope.error.code;
}

beforeEach(() => {
  sequence = 0;
  originAnswer = { allowed: true };
  vi.clearAllMocks();
  queue = createReviewQueue();
  reviewStatus = createReviewStatusStore();
  ledger = new ReviewCycleLedger({
    path: ":memory:",
    now: () => new Date("2026-10-25T00:00:00Z"),
    newCandidateId: () => `cand_01jbq3x8n5r7t9v2w4y6z8a0d${++sequence}`,
  });
});

afterEach(() => {
  ledger.close();
});

describe("入力の検証", () => {
  test.each<[string, InternalToolName, Record<string, unknown>]>([
    ["未知の項目", "accept_review_candidate", { ...acceptInput, extra: true }],
    ["自己申告の主体", "accept_review_candidate", { ...acceptInput, requestedBy: "alice" }],
    [
      "schemaVersion が無い",
      "cancel_review_candidate",
      { ...cancelInput, schemaVersion: undefined },
    ],
    ["HEAD が大文字", "cancel_review_candidate", { ...cancelInput, headSha: HEAD.toUpperCase() }],
    ["取消 ID の書式", "cancel_review_candidate", { ...cancelInput, cancelId: "cxl_short" }],
    ["candidateId が無い", "get_review_result", { schemaVersion: 1, cycleId: CYCLE }],
  ])("不正な入力は INVALID_ARGUMENT（%s）で、副作用がない", async (_name, tool, input) => {
    const outcome = await call(tool, input);
    expect(errorCode(outcome)).toBe("INVALID_ARGUMENT");
    expect(ledger.findByCycle(CYCLE)).toBeUndefined();
  });
});

describe("認可", () => {
  test.each<[string, InternalToolName, unknown, string]>([
    ["未登録のサービス", "accept_review_candidate", acceptInput, "svc-unknown"],
    ["操作が許可されていない", "accept_review_candidate", acceptInput, "svc-reader"],
    ["repo が許可されていない", "accept_review_candidate", acceptInput, "svc-elsewhere"],
  ])("accept: %s は PERMISSION_DENIED", async (_name, tool, input, principal) => {
    expect(errorCode(await call(tool, input, principal))).toBe("PERMISSION_DENIED");
    expect(ledger.findByCycle(CYCLE)).toBeUndefined();
  });

  test("主体の大文字小文字は区別しない", async () => {
    expect((await call("accept_review_candidate", acceptInput, "SVC-Raven")).ok).toBe(true);
  });

  test("受付済みの cycle は、対象 repo が許可されたサービスだけが取消・結果参照できる", async () => {
    const accepted = await call("accept_review_candidate", acceptInput);
    const candidateId = accepted.ok ? (accepted.output.candidateId as string) : "";
    const lookup = { schemaVersion: 1, cycleId: CYCLE, candidateId };

    expect(errorCode(await call("cancel_review_candidate", cancelInput, "svc-elsewhere"))).toBe(
      "PERMISSION_DENIED",
    );
    expect(errorCode(await call("get_review_result", lookup, "svc-elsewhere"))).toBe(
      "PERMISSION_DENIED",
    );
    expect((await call("get_review_result", lookup, "svc-reader")).ok).toBe(true);
    expect(errorCode(await call("cancel_review_candidate", cancelInput, "svc-reader"))).toBe(
      "PERMISSION_DENIED",
    );
  });

  test("未受理の cycle の取消は、操作の許可だけで受け付ける（repo が不明なため）", async () => {
    expect((await call("cancel_review_candidate", cancelInput, "svc-elsewhere")).ok).toBe(true);
  });
});

describe("accept_review_candidate", () => {
  test("受け付けて candidateId を返し、再送は duplicate", async () => {
    const first = await call("accept_review_candidate", acceptInput);
    expect(first).toEqual({
      ok: true,
      output: {
        schemaVersion: 1,
        candidateId: "cand_01jbq3x8n5r7t9v2w4y6z8a0d1",
        duplicate: false,
      },
    });
    const again = await call("accept_review_candidate", acceptInput);
    expect(again.ok && again.output.duplicate).toBe(true);
  });

  test("origin policy に違反する候補は ORIGIN_REJECTED で、何も永続しない", async () => {
    originAnswer = { allowed: false, reason: "fork" };
    const outcome = await call("accept_review_candidate", acceptInput);
    expect(errorCode(outcome)).toBe("ORIGIN_REJECTED");
    expect(!outcome.ok && outcome.envelope.error.message).toContain("fork");
    expect(ledger.findByCycle(CYCLE)).toBeUndefined();
  });

  test("台帳の契約エラー（HEAD 競合）はそのまま返す", async () => {
    await call("accept_review_candidate", acceptInput);
    const conflict = await call("accept_review_candidate", {
      ...acceptInput,
      headSha: "89abcdef0123456789abcdef0123456789abcdef",
    });
    expect(errorCode(conflict)).toBe("HEAD_CONFLICT");
  });
});

describe("想定外の例外", () => {
  test("内容を返さず、再送可能な UNAVAILABLE にしてログに残す", async () => {
    const outcome = await call("accept_review_candidate", acceptInput, "svc-raven", {
      ...deps(),
      checkOrigin: async () => {
        throw new TypeError("secret-token-in-message");
      },
    });
    expect(errorCode(outcome)).toBe("UNAVAILABLE");
    expect(!outcome.ok && outcome.envelope.error.retryable).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("secret-token");
    expect(logger.error).toHaveBeenCalledWith(
      "internal.tool.error",
      expect.objectContaining({ tool: "accept_review_candidate", errorName: "TypeError" }),
    );
  });
});

describe("共有シナリオ（raven → owl の手順）", () => {
  const root = fileURLToPath(new URL("../contract/v1/scenarios/scenarios.json", import.meta.url));
  const scenarios = JSON.parse(readFileSync(root, "utf8")) as {
    scenarios?: unknown[];
  } & unknown[] as unknown as {
    id: string;
    steps: {
      actor?: string;
      op?: string;
      event?: string;
      input?: unknown;
      expect?: Record<string, unknown>;
    }[];
  }[];
  const tools = Object.keys(INTERNAL_TOOLS);

  // シナリオが前提とする owl の状態（event・先行する別 actor の手順の結果）
  const setups: Record<string, () => Promise<void>> = {
    "cancel-conflicts": async () => {
      // cyc…c1 は結果の投稿が先に確定、cyc…c2 は GitHub 書込みが進行中で結果不明
      const c1 = ledger.accept({ ...acceptInput, installationId: 1 });
      ledger.beginResultWrite(c1.candidateId);
      ledger.recordResultPosted(c1.candidateId, {
        kind: "approved",
        headSha: HEAD,
        post: {
          commentId: 6384700041,
          url: "https://github.com/scottlz0310/mcp-resource-subscriber/pull/226#issuecomment-6384700041",
        },
        postedAt: "2026-10-25T00:00:00Z",
      });
      const c2 = ledger.accept({ ...acceptInput, cycleId: CYCLE_2, installationId: 1 });
      ledger.beginResultWrite(c2.candidateId);
    },
    "result-recovery-from-owl-index": async () => {
      ledger.accept({ ...acceptInput, installationId: 1 });
    },
    "owl-origin-and-delivery-limits": async () => {
      originAnswer = { allowed: false, reason: "fork" };
    },
  };
  // 手順の途中の event が起こす状態の変化
  const events: Record<string, () => void> = {
    "owl が GitHub 投稿後に停止し、再起動後に投稿 ID の相関から結果索引を復元した": () => {
      const found = ledger.findByCycle(CYCLE);
      if (!found) throw new Error("setup");
      ledger.beginResultWrite(found.candidateId);
      ledger.recordResultPosted(found.candidateId, {
        kind: "approved",
        headSha: HEAD,
        post: {
          commentId: 6384700041,
          url: "https://github.com/scottlz0310/mcp-resource-subscriber/pull/226#issuecomment-6384700041",
        },
        postedAt: "2026-10-25T00:00:00Z",
      });
    },
  };

  const relevant = scenarios.filter((s) => s.steps.some((t) => t.op && tools.includes(t.op)));

  test("対象のシナリオが存在する", () => {
    expect(relevant.map((s) => s.id).sort()).toEqual([
      "cancel-before-accept",
      "cancel-conflicts",
      "owl-origin-and-delivery-limits",
      "recover-failed-cycle-with-cancel",
      "result-recovery-from-owl-index",
      "webhook-and-manual-merge",
    ]);
  });

  test.each(relevant.map((s) => [s.id, s] as const))("%s", async (id, scenario) => {
    await setups[id]?.();
    for (const step of scenario.steps) {
      if (step.event) {
        events[step.event]?.();
        continue;
      }
      if (!step.op || !tools.includes(step.op)) {
        continue;
      }
      const outcome = await call(step.op as InternalToolName, step.input);
      const expected = step.expect ?? {};
      if ("error" in expected) {
        expect(errorCode(outcome), `${id}: ${step.op}`).toBe(expected.error);
      } else {
        expect(outcome.ok && outcome.output, `${id}: ${step.op}`).toEqual(expected.output);
      }
    }
  });
});

describe("review queue との連携", () => {
  const pr = { owner: "scottlz0310", repo: "mcp-resource-subscriber", prNumber: 226 };

  test("accept は候補を既存の queue に cycle 付きで載せ、status を pending にする", async () => {
    await call("accept_review_candidate", acceptInput);
    expect(queue.list()).toEqual([
      expect.objectContaining({
        ...pr,
        installationId: 4242,
        reason: "opened",
        cycle: {
          candidateId: "cand_01jbq3x8n5r7t9v2w4y6z8a0d1",
          cycleId: CYCLE,
          round: 1,
          headSha: HEAD,
        },
      }),
    ]);
    expect(reviewStatus.get(pr)?.status).toBe("pending");
  });

  test("同じ候補の再送（duplicate）は、queue に載せ直さず、status のラウンドも進めない", async () => {
    await call("accept_review_candidate", acceptInput);
    const round = reviewStatus.currentRound(pr);
    queue.removeCycle(CYCLE);
    const again = await call("accept_review_candidate", acceptInput);
    expect(again.ok && again.output.duplicate).toBe(true);
    expect(queue.size()).toBe(0);
    expect(reviewStatus.currentRound(pr)).toBe(round);
  });

  test("origin に違反する候補は、queue にも status にも載せない", async () => {
    originAnswer = { allowed: false, reason: "fork" };
    await call("accept_review_candidate", acceptInput);
    expect(queue.size()).toBe(0);
    expect(reviewStatus.get(pr)).toBeUndefined();
  });

  test("installation を解決できなければ UNAVAILABLE で、台帳にも queue にも残さない（再送できる）", async () => {
    const failing = deps({
      resolveInstallationId: async () => {
        throw new Error("github down");
      },
    });
    const outcome = await call("accept_review_candidate", acceptInput, "svc-raven", failing);
    expect(errorCode(outcome)).toBe("UNAVAILABLE");
    expect(ledger.findByCycle(CYCLE)).toBeUndefined();
    expect(queue.size()).toBe(0);
    const retry = await call("accept_review_candidate", acceptInput);
    expect(retry.ok && retry.output.duplicate).toBe(false);
  });

  test("取消は、queue から候補を外す", async () => {
    await call("accept_review_candidate", acceptInput);
    expect((await call("cancel_review_candidate", cancelInput)).ok).toBe(true);
    expect(queue.size()).toBe(0);
  });

  test("書込み中で取消が保留（CANCEL_UNCONFIRMED）でも、reviewer が走り出さないよう queue から外す", async () => {
    const accepted = await call("accept_review_candidate", acceptInput);
    ledger.beginResultWrite(accepted.ok ? (accepted.output.candidateId as string) : "");
    expect(errorCode(await call("cancel_review_candidate", cancelInput))).toBe(
      "CANCEL_UNCONFIRMED",
    );
    expect(queue.size()).toBe(0);
  });

  test("結果の投稿が先着していれば（CANCEL_RESULT_POSTED）、候補を外さない", async () => {
    const accepted = await call("accept_review_candidate", acceptInput);
    const candidateId = accepted.ok ? (accepted.output.candidateId as string) : "";
    ledger.beginResultWrite(candidateId);
    ledger.recordResultPosted(candidateId, {
      kind: "approved",
      headSha: HEAD,
      post: { commentId: 1, url: "https://github.com/o/r/pull/1#issuecomment-1" },
      postedAt: "2026-10-25T00:00:00Z",
    });
    expect(errorCode(await call("cancel_review_candidate", cancelInput))).toBe(
      "CANCEL_RESULT_POSTED",
    );
    expect(queue.size()).toBe(1);
  });

  test("旧経路の enqueue（cycle なし）が後から来ても、cycle 付きの候補は残る", async () => {
    await call("accept_review_candidate", acceptInput);
    queue.enqueue({ ...pr, installationId: 1, queuedAt: new Date(), reason: "synchronized" });
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0].cycle?.cycleId).toBe(CYCLE);
  });
});
