import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createReviewQueue } from "../queue/review-queue.js";
import { createReviewStatusStore } from "../queue/review-status.js";
import { loadInternalSurfaceConfig } from "./config.js";
import { ReviewCycleLedger } from "./ledger.js";
import { restoreQueue, startInternalSurface } from "./surface.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owl-surface-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function acceptOf(n: number, extra: Record<string, unknown> = {}) {
  return {
    cycleId: `cyc_01jbq3x8n5r7t9v2w4y6z8a0c${n}`,
    round: 1,
    owner: "org",
    repo: "repo",
    prNumber: 100 + n,
    headSha: HEAD,
    reason: "opened" as const,
    sourceId: null,
    installationId: 7,
    ...extra,
  };
}

describe("restoreQueue", () => {
  test("受付済みで未起動・未取消の候補だけを、受付順に queue と status へ戻す", () => {
    const ledger = new ReviewCycleLedger({ path: join(dir, "ledger.sqlite") });
    try {
      const queued = ledger.accept(acceptOf(1));
      const started = ledger.accept(acceptOf(2));
      ledger.start(started.candidateId);
      ledger.accept(acceptOf(3));
      ledger.cancel({
        cycleId: acceptOf(3).cycleId,
        round: 1,
        headSha: HEAD,
        cancelId: "cxl_01jbq3x8n5r7t9v2w4y6z8a0e1",
      });
      ledger.accept(acceptOf(4, { reason: "re-review-requested" }));

      const queue = createReviewQueue();
      const reviewStatus = createReviewStatusStore();
      expect(restoreQueue(ledger, queue, reviewStatus)).toBe(2);

      expect(
        queue.list().map((c) => [c.prNumber, c.reason, c.installationId, c.cycle?.candidateId]),
      ).toEqual([
        [101, "opened", 7, queued.candidateId],
        [104, "re-review-requested", 7, ledger.findByCycle(acceptOf(4).cycleId)?.candidateId],
      ]);
      expect(reviewStatus.get({ owner: "org", repo: "repo", prNumber: 101 })?.status).toBe(
        "pending",
      );
      expect(reviewStatus.get({ owner: "org", repo: "repo", prNumber: 102 })).toBeUndefined();
    } finally {
      ledger.close();
    }
  });

  test("受付がなければ何も戻さない", () => {
    const ledger = new ReviewCycleLedger({ path: ":memory:" });
    try {
      expect(restoreQueue(ledger, createReviewQueue())).toBe(0);
    } finally {
      ledger.close();
    }
  });
});

describe("startInternalSurface", () => {
  test("台帳のファイルを作成し、起動時に queue を再構築し、内部パス以外は処理せず、停止で台帳を閉じる", async () => {
    const ledgerPath = join(dir, "ledger.sqlite");
    const seed = new ReviewCycleLedger({ path: ledgerPath });
    seed.accept(acceptOf(1));
    seed.close();

    const config = loadInternalSurfaceConfig(
      {
        THREAD_OWL_LEDGER_PATH: ledgerPath,
        THREAD_OWL_INTERNAL_PROXY_SECRET: "proxy-secret-0123456789",
        THREAD_OWL_SERVICE_ACL: JSON.stringify({
          services: { s: { actions: ["accept"], repos: ["org/*"] } },
        }),
      },
      "/mcp",
    );
    if (!config) throw new Error("setup");
    const queue = createReviewQueue();
    const surface = startInternalSurface(
      config,
      { getClient: vi.fn(), allowedRepos: [], allowedAuthors: [], resolveInstallationId: vi.fn() },
      { queue },
      logger,
      "0.0.0-test",
    );
    expect(queue.size()).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "internal.queue.restored",
      expect.objectContaining({ count: 1 }),
    );

    const res = { writeHead: vi.fn(), end: vi.fn() };
    await expect(
      surface.handle({ url: "/elsewhere", headers: {} } as never, res as never),
    ).resolves.toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();

    await surface.close();
    expect(existsSync(ledgerPath)).toBe(true);
  });
});
