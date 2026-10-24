import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ReviewCycleLedger } from "./ledger.js";

const CYCLE = "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1";
const CANDIDATE = "cand_01jbq3x8n5r7t9v2w4y6z8a0d1";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

// 以前の版で作られた台帳の表。世代ごとに、候補の表の列が違う。
const CANCELLATIONS_AND_RESULTS = `
CREATE TABLE cancellations (
  cycle_id TEXT PRIMARY KEY, cancel_id TEXT NOT NULL, round INTEGER NOT NULL, head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'confirmed')),
  requested_at TEXT NOT NULL, confirmed_at TEXT
);
CREATE TABLE results (
  cycle_id TEXT NOT NULL, result_version INTEGER NOT NULL, candidate_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reviewed', 'approved')), head_sha TEXT NOT NULL,
  comment_id INTEGER NOT NULL, url TEXT NOT NULL, posted_at TEXT NOT NULL,
  PRIMARY KEY (cycle_id, result_version), UNIQUE (cycle_id, comment_id)
);`;

const CANDIDATES_BASE = `
  candidate_id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL UNIQUE, round INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
  reason TEXT NOT NULL, source_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'started')),
  write_state TEXT NOT NULL DEFAULT 'idle' CHECK (write_state IN ('idle', 'in-progress')),
  accepted_at TEXT NOT NULL, started_at TEXT`;

const GENERATIONS: Array<{
  name: string;
  candidates: string;
  extraColumns: string;
  outbox: boolean;
}> = [
  // 台帳の基盤（O1 段階1）
  { name: "段階1の台帳", candidates: CANDIDATES_BASE, extraColumns: "", outbox: false },
  // queue 連携・投稿の束縛まで（installation_id・write_id・write_kind あり、版の列なし）、結果の通知の outbox あり
  {
    name: "段階3cの台帳（版の列なし）",
    candidates: `${CANDIDATES_BASE}, installation_id INTEGER NOT NULL, write_id TEXT, write_kind TEXT`,
    extraColumns: ", 7, NULL, NULL",
    outbox: true,
  },
];

const OUTBOX = `
CREATE TABLE result_outbox (
  cycle_id TEXT NOT NULL, result_version INTEGER NOT NULL, candidate_id TEXT NOT NULL, kind TEXT NOT NULL,
  head_sha TEXT NOT NULL, comment_id INTEGER NOT NULL, url TEXT NOT NULL, posted_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL, last_error TEXT, finished_at TEXT,
  PRIMARY KEY (cycle_id, result_version)
);`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owl-migrate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedOldLedger(path: string, generation: (typeof GENERATIONS)[number]): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE candidates (${generation.candidates});`);
  db.exec(CANCELLATIONS_AND_RESULTS);
  if (generation.outbox) {
    db.exec(OUTBOX);
  }
  db.exec(
    `INSERT INTO candidates VALUES ('${CANDIDATE}', '${CYCLE}', 1, 'org', 'repo', 5, '${HEAD}', 'opened', NULL, 'started', 'idle', '2026-10-01T00:00:00Z', NULL${generation.extraColumns})`,
  );
  // 版 1・2 が結果索引にある
  for (const version of [1, 2]) {
    db.exec(
      `INSERT INTO results VALUES ('${CYCLE}', ${version}, '${CANDIDATE}', 'reviewed', '${HEAD}', ${100 + version}, 'https://github.com/org/repo/pull/5#issuecomment-${100 + version}', '2026-10-01T00:00:00Z')`,
    );
  }
  if (generation.outbox) {
    // 結果索引より新しい版 3 の通知が、送信待ちで残っている
    db.exec(
      `INSERT INTO result_outbox (cycle_id, result_version, candidate_id, kind, head_sha, comment_id, url, posted_at, next_attempt_at)
       VALUES ('${CYCLE}', 3, '${CANDIDATE}', 'approved', '${HEAD}', 103, 'https://github.com/org/repo/pull/5#issuecomment-103', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    );
  }
  db.close();
}

describe.each(GENERATIONS)("以前の台帳を開く: $name", (generation) => {
  const expectedNext = generation.outbox ? 4 : 3;

  test("列を足して開け、次の結果は既存の版の次になる（版が衝突しない）", () => {
    const path = join(dir, "ledger.sqlite");
    seedOldLedger(path, generation);

    const ledger = new ReviewCycleLedger({ path });
    try {
      const posted = ledger.recordResultPosted(CANDIDATE, {
        kind: "approved",
        headSha: HEAD,
        post: { commentId: 999, url: "https://github.com/org/repo/pull/5#issuecomment-999" },
        postedAt: "2026-10-25T00:00:00Z",
      });
      expect(posted.resultVersion).toBe(expectedNext);
    } finally {
      ledger.close();
    }
  });

  test("新しい列を使う操作（進行中の書込みの識別・受付）が、既存の台帳でも動く", () => {
    const path = join(dir, "ledger.sqlite");
    seedOldLedger(path, generation);

    const ledger = new ReviewCycleLedger({ path });
    try {
      // 既存の候補: 書込みの識別
      const begun = ledger.beginResultWrite(CANDIDATE, "reviewed");
      expect(ledger.pendingWriteByCycle(CYCLE)?.writeId).toBe(begun.writeId);
      ledger.abortResultWrite(CANDIDATE, begun.writeId);

      // 新しい受付: installationId を保持する
      const fresh = ledger.accept({
        cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c2",
        round: 1,
        owner: "org",
        repo: "repo",
        prNumber: 6,
        headSha: HEAD,
        reason: "opened",
        sourceId: null,
        installationId: 42,
      });
      expect(ledger.listQueued().map((q) => [q.candidateId, q.installationId])).toEqual([
        [fresh.candidateId, 42],
      ]);
    } finally {
      ledger.close();
    }
  });

  test("何度開いても同じ（移行は冪等）で、既存の版を巻き戻さない", () => {
    const path = join(dir, "ledger.sqlite");
    seedOldLedger(path, generation);
    new ReviewCycleLedger({ path }).close();

    const ledger = new ReviewCycleLedger({ path });
    try {
      const posted = ledger.recordResultPosted(CANDIDATE, {
        kind: "reviewed",
        headSha: HEAD,
        post: { commentId: 998, url: "https://github.com/org/repo/pull/5#issuecomment-998" },
        postedAt: "2026-10-25T00:00:00Z",
      });
      expect(posted.resultVersion).toBe(expectedNext);
    } finally {
      ledger.close();
    }
  });
});

test("新規の台帳を開き直しても、版は巻き戻らない", () => {
  const path = join(dir, "ledger.sqlite");
  const first = new ReviewCycleLedger({ path });
  const { candidateId } = first.accept({
    cycleId: CYCLE,
    round: 1,
    owner: "org",
    repo: "repo",
    prNumber: 5,
    headSha: HEAD,
    reason: "opened",
    sourceId: null,
    installationId: 1,
  });
  first.recordResultPosted(candidateId, {
    kind: "reviewed",
    headSha: HEAD,
    post: { commentId: 1, url: "https://github.com/org/repo/pull/5#issuecomment-1" },
    postedAt: "2026-10-25T00:00:00Z",
  });
  first.close();

  const second = new ReviewCycleLedger({ path });
  try {
    expect(
      second.recordResultPosted(candidateId, {
        kind: "reviewed",
        headSha: HEAD,
        post: { commentId: 2, url: "https://github.com/org/repo/pull/5#issuecomment-2" },
        postedAt: "2026-10-25T00:00:00Z",
      }).resultVersion,
    ).toBe(2);
  } finally {
    second.close();
  }
});
