import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
      { queue, botLogin: "thread-owl[bot]" },
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

describe("容量", () => {
  test("101 件の受付は、すべて queue に戻り、旧経路の項目が混在しても押し出されない", () => {
    const ledger = new ReviewCycleLedger({ path: ":memory:" });
    try {
      for (let n = 1; n <= 101; n++) {
        ledger.accept({
          cycleId: `cyc_${String(n).padStart(26, "0")}`,
          round: 1,
          owner: "org",
          repo: "repo",
          prNumber: n,
          headSha: HEAD,
          reason: "opened",
          sourceId: null,
          installationId: 7,
        });
      }
      const queue = createReviewQueue();
      for (let pr = 5000; pr < 5101; pr++) {
        queue.enqueue({
          owner: "org",
          repo: "legacy",
          prNumber: pr,
          installationId: 1,
          queuedAt: new Date(),
          reason: "opened",
        });
      }
      expect(restoreQueue(ledger, queue)).toBe(101);
      expect(queue.list().filter((c) => c.cycle !== undefined)).toHaveLength(101);
      expect(queue.list().filter((c) => c.cycle === undefined)).toHaveLength(100);
    } finally {
      ledger.close();
    }
  });
});

describe("結果の配送 worker", () => {
  test("設定すると、記録された結果を review-raven へ送り、停止で止まる", async () => {
    const received: string[] = [];
    const fake = createServer((req, res) => {
      received.push(req.headers.authorization ?? "");
      res.writeHead(503).end(); // 届かない相手でも、停止が止まらないこと・資格情報が出ないことを確認する
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    try {
      const ledgerPath = join(dir, "ledger.sqlite");
      const config = loadInternalSurfaceConfig(
        {
          THREAD_OWL_LEDGER_PATH: ledgerPath,
          THREAD_OWL_INTERNAL_PROXY_SECRET: "proxy-secret-0123456789",
          THREAD_OWL_SERVICE_ACL: JSON.stringify({
            services: { s: { actions: ["accept"], repos: ["org/*"] } },
          }),
          THREAD_OWL_RAVEN_INTERNAL_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/internal/mcp`,
          THREAD_OWL_RAVEN_INTERNAL_TOKEN: "service-credential-0123456789",
          THREAD_OWL_DELIVERY_INTERVAL_SEC: "1",
        },
        "/mcp",
      );
      if (!config) throw new Error("setup");
      const seed = new ReviewCycleLedger({ path: ledgerPath });
      const { candidateId } = seed.accept(acceptOf(1));
      seed.recordResultPosted(candidateId, {
        kind: "reviewed",
        headSha: HEAD,
        post: { commentId: 1, url: "https://github.com/org/repo/pull/101#issuecomment-1" },
        postedAt: "2026-10-25T00:00:00Z",
      });
      seed.close();

      const surface = startInternalSurface(
        config,
        {
          getClient: vi.fn(),
          allowedRepos: [],
          allowedAuthors: [],
          resolveInstallationId: vi.fn(),
        },
        { queue: createReviewQueue(), botLogin: "thread-owl[bot]" },
        logger,
        "0.0.0-test",
      );
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 5000 });
      expect(received[0]).toBe("Bearer service-credential-0123456789");
      expect(logger.info).toHaveBeenCalledWith(
        "internal.result.delivery.started",
        expect.objectContaining({ intervalMs: 1000 }),
      );
      await surface.close();
    } finally {
      fake.closeAllConnections();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});

describe("webhook・コメント由来の候補の記録（ingest）", () => {
  const baseEnv = (ledgerPath: string) => ({
    THREAD_OWL_LEDGER_PATH: ledgerPath,
    THREAD_OWL_INTERNAL_PROXY_SECRET: "proxy-secret-0123456789",
    THREAD_OWL_SERVICE_ACL: JSON.stringify({
      services: { s: { actions: ["accept"], repos: ["org/*"] } },
    }),
  });
  const tools = {
    getClient: vi.fn(),
    allowedRepos: [],
    allowedAuthors: [],
    resolveInstallationId: vi.fn(),
  };

  test("配送を設定していなければ、記録の窓口は無い（積んでも送り先が無いため）", async () => {
    const config = loadInternalSurfaceConfig(baseEnv(join(dir, "ledger.sqlite")), "/mcp");
    if (!config) throw new Error("setup");
    const surface = startInternalSurface(
      config,
      tools,
      { queue: createReviewQueue(), botLogin: "thread-owl[bot]" },
      logger,
      "0.0.0-test",
    );
    expect(surface.ingest).toBeUndefined();
    await surface.close();
  });

  test("配送を設定すると窓口があり、記録した候補を review-raven の ingest_review_candidate へ送る", async () => {
    const received: Array<{ authorization: string | undefined }> = [];
    const fake = createServer((req, res) => {
      received.push({ authorization: req.headers.authorization });
      res.writeHead(503).end();
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    try {
      const config = loadInternalSurfaceConfig(
        {
          ...baseEnv(join(dir, "ledger.sqlite")),
          THREAD_OWL_RAVEN_INTERNAL_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/internal/mcp`,
          THREAD_OWL_RAVEN_INTERNAL_TOKEN: "service-credential-0123456789",
          THREAD_OWL_DELIVERY_INTERVAL_SEC: "1",
        },
        "/mcp",
      );
      if (!config) throw new Error("setup");
      const surface = startInternalSurface(
        config,
        tools,
        { queue: createReviewQueue(), botLogin: "thread-owl[bot]" },
        logger,
        "0.0.0-test",
      );
      expect(surface.ingest).toBeDefined();
      surface.ingest?.record({
        sourceId: "delivery:0f1e2d3c-0001",
        owner: "org",
        repo: "repo",
        prNumber: 5,
        headSha: HEAD,
        reason: "opened",
        delivery: "webhook",
      });
      await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), { timeout: 5000 });
      expect(received[0].authorization).toBe("Bearer service-credential-0123456789");
      await surface.close();
    } finally {
      fake.closeAllConnections();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});
