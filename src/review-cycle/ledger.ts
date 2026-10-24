import { randomBytes, randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ContractError } from "./errors.js";

export type CandidateReason = "opened" | "synchronized" | "re-review-requested";
export type ResultKind = "reviewed" | "approved";
export type CandidateStatus = "not-accepted" | "queued" | "started";

export interface AcceptInput {
  cycleId: string;
  round: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reason: CandidateReason;
  sourceId: string | null;
}

/** 台帳へ受け付ける候補。installationId は raven の入力ではなく、受付時に owl が解決する。 */
export interface LedgerAccept extends AcceptInput {
  installationId: number;
}

/** 受付済みで、まだ reviewer が起動していない候補（再起動後の queue の再構築に使う）。 */
export interface QueuedCandidate extends CandidateBinding {
  installationId: number;
  reason: CandidateReason;
  acceptedAt: string;
}

export interface CancelInput {
  cycleId: string;
  round: number;
  headSha: string;
  cancelId: string;
}

export interface ResultPost {
  /**
   * この投稿を記録する書込みの ID。指定時は、その書込みが現在も進行中のときだけ「進行中」を解除する
   * （照合している間に始まった別の書込みを解除しない）。
   */
  writeId?: string;
  kind: ResultKind;
  headSha: string;
  post: { commentId: number; url: string };
  postedAt: string;
}

export interface ReviewResult {
  source: "thread-owl";
  kind: ResultKind;
  headSha: string;
  resultVersion: number;
  post: { commentId: number; url: string };
}

/** reviewer の起動から結果投稿までを束縛する cycle の同一性（投稿時に現在の round を引き直さない）。 */
export interface CandidateBinding {
  candidateId: string;
  cycleId: string;
  round: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/** 未起動の候補の既定の上限。超える新規の受付は、永続せず UNAVAILABLE（再送可）にする。 */
export const DEFAULT_MAX_QUEUED_CANDIDATES = 1000;

/** 進行中（または結果不明）の GitHub 書込み。投稿本文の相関マーカーの writeId で照合する。 */
export interface PendingWrite extends CandidateBinding {
  writeId: string;
  kind: ResultKind;
}

/** review-raven へ送る結果の通知（publish_review_result の入力と同じ項目）。 */
export interface ResultMessage {
  cycleId: string;
  candidateId: string;
  headSha: string;
  resultVersion: number;
  kind: ResultKind;
  post: { commentId: number; url: string };
  postedAt: string;
}

export interface DueResultMessage {
  message: ResultMessage;
  /** これまでの送信の試行回数。 */
  attempts: number;
}

/**
 * webhook・コメント由来の候補を、review-raven の共通受付（ingest_review_candidate）へ渡す通知。
 * sourceId（配送 ID・コメント ID）で冪等に積み、raven が cycle を作る。
 */
export interface IngestMessage {
  sourceId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  reason: CandidateReason;
  delivery: "webhook" | "comment";
}

export interface DueIngestMessage {
  message: IngestMessage;
  attempts: number;
}

/** 保持期限で削除した行数。 */
export interface PurgeReport {
  /** 削除した候補の cycleId。in-memory の queue から外すために使う。 */
  purgedCycleIds: string[];
  candidates: number;
  results: number;
  cancellations: number;
  resultOutbox: number;
  ingestOutbox: number;
}

export interface LedgerOptions {
  /** SQLite のファイルパス。":memory:" で永続化なし（テスト用）。 */
  path: string;
  /** 受付済みで未起動・未取消の候補の上限。 */
  maxQueued?: number;
  now?: () => Date;
  newCandidateId?: () => string;
  newWriteId?: () => string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  cycle_id     TEXT NOT NULL UNIQUE,
  round        INTEGER NOT NULL,
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  pr_number    INTEGER NOT NULL,
  head_sha     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  source_id    TEXT,
  installation_id INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('queued', 'started')),
  write_state  TEXT NOT NULL DEFAULT 'idle' CHECK (write_state IN ('idle', 'in-progress')),
  write_id     TEXT,
  write_kind   TEXT,
  last_result_version INTEGER NOT NULL DEFAULT 0,
  accepted_at  TEXT NOT NULL,
  started_at   TEXT
);
CREATE TABLE IF NOT EXISTS cancellations (
  cycle_id     TEXT PRIMARY KEY,
  cancel_id    TEXT NOT NULL,
  round        INTEGER NOT NULL,
  head_sha     TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('requested', 'confirmed')),
  requested_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE TABLE IF NOT EXISTS results (
  cycle_id       TEXT NOT NULL,
  result_version INTEGER NOT NULL,
  candidate_id   TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('reviewed', 'approved')),
  head_sha       TEXT NOT NULL,
  comment_id     INTEGER NOT NULL,
  url            TEXT NOT NULL,
  posted_at      TEXT NOT NULL,
  PRIMARY KEY (cycle_id, result_version),
  UNIQUE (cycle_id, comment_id)
);
CREATE TABLE IF NOT EXISTS result_outbox (
  cycle_id        TEXT NOT NULL,
  result_version  INTEGER NOT NULL,
  candidate_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,
  head_sha        TEXT NOT NULL,
  comment_id      INTEGER NOT NULL,
  url             TEXT NOT NULL,
  posted_at       TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'delivered', 'rejected', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  finished_at     TEXT,
  PRIMARY KEY (cycle_id, result_version)
);
CREATE TABLE IF NOT EXISTS ingest_outbox (
  source_id       TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  repo            TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  head_sha        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  delivery        TEXT NOT NULL CHECK (delivery IN ('webhook', 'comment')),
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'delivered', 'rejected', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  finished_at     TEXT
);
`;

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `cand_` + 26 文字（時刻 10 文字 + 乱数 16 文字）。契約の candidateId の書式。 */
function generateCandidateId(now: Date): string {
  const time = now.getTime().toString(36).padStart(10, "0").slice(-10);
  let random = "";
  for (let i = 0; i < 16; i++) {
    random += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return `cand_${time}${random}`;
}

interface CandidateRow {
  candidate_id: string;
  cycle_id: string;
  round: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  reason: string;
  source_id: string | null;
  installation_id: number;
  accepted_at: string;
  status: "queued" | "started";
  write_state: "idle" | "in-progress";
  write_id: string | null;
  write_kind: ResultKind | null;
  last_result_version: number;
}

interface OutboxRow {
  cycle_id: string;
  result_version: number;
  candidate_id: string;
  kind: ResultKind;
  head_sha: string;
  comment_id: number;
  url: string;
  posted_at: string;
  attempts: number;
}

interface IngestRow {
  source_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  reason: CandidateReason;
  delivery: "webhook" | "comment";
  attempts: number;
}

interface CancellationRow {
  cycle_id: string;
  cancel_id: string;
  round: number;
  head_sha: string;
  state: "requested" | "confirmed";
}

interface ResultRow {
  result_version: number;
  kind: ResultKind;
  head_sha: string;
  comment_id: number;
  url: string;
}

/**
 * reviewer 側（thread-owl）の永続台帳。候補の受付、取消記録、結果索引を持つ。
 * 取消は未受理の cycle にも記録し、旧候補の起動と新規投稿を拒否する。
 * 結果の本文・Verdict は複製せず、GitHub 投稿への参照だけを保存する。
 */
export class ReviewCycleLedger {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly newCandidateId: () => string;
  private readonly newWriteId: () => string;
  private readonly maxQueued: number;

  constructor(options: LedgerOptions) {
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrate();
    this.now = options.now ?? (() => new Date());
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED_CANDIDATES;
    this.newWriteId = options.newWriteId ?? (() => randomBytes(8).toString("hex"));
    this.newCandidateId = options.newCandidateId ?? (() => generateCandidateId(this.now()));
  }

  close(): void {
    this.db.close();
  }

  /**
   * 以前の版で作られた台帳（候補の表に列が足りない）を開いたときに、列を足す。
   * CREATE TABLE IF NOT EXISTS は、既存の表に列を足さないため。
   * - installation_id: 以前の候補は不明（0）。復元した queue の項目の installationId が 0 になるだけで、他では使わない。
   * - write_id / write_kind: 進行中の書込みの識別。以前の版は、投稿の束縛をまだ使っていなかったため、進行中の行は無い。
   * - last_result_version: 結果の版の採番。既存の結果（索引と通知）の最大版から始め、既存の版と衝突させない。
   */
  private migrate(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(candidates)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    this.transaction(() => {
      const add = (name: string, definition: string): boolean => {
        if (columns.has(name)) {
          return false;
        }
        this.db.exec(`ALTER TABLE candidates ADD COLUMN ${definition}`);
        return true;
      };
      add("installation_id", "installation_id INTEGER NOT NULL DEFAULT 0");
      add("write_id", "write_id TEXT");
      add("write_kind", "write_kind TEXT");
      if (add("last_result_version", "last_result_version INTEGER NOT NULL DEFAULT 0")) {
        this.db.exec(
          `UPDATE candidates SET last_result_version = MAX(
             COALESCE((SELECT MAX(result_version) FROM results r WHERE r.cycle_id = candidates.cycle_id), 0),
             COALESCE((SELECT MAX(result_version) FROM result_outbox o WHERE o.cycle_id = candidates.cycle_id), 0)
           )`,
        );
      }
    });
  }

  /** 候補を受け付ける。同じ cycle の同一内容の再送は同じ candidateId を返す（duplicate）。 */
  accept(input: LedgerAccept): { candidateId: string; duplicate: boolean } {
    return this.transaction(() => {
      if (this.cancellation(input.cycleId)) {
        throw new ContractError("CANDIDATE_CANCELLED", "取消済みの cycle の候補は受け付けない");
      }
      const existing = this.candidateByCycle(input.cycleId);
      if (existing) {
        this.assertSameCandidate(existing, input);
        return { candidateId: existing.candidate_id, duplicate: true };
      }
      // 未起動の候補が上限なら、新規の受付は永続せず再送可能にする（queue から黙って脱落させない）。
      if (this.countQueued() >= this.maxQueued) {
        throw new ContractError(
          "UNAVAILABLE",
          "未起動の候補が上限に達しているため、いまは受け付けられない",
        );
      }
      const candidateId = this.newCandidateId();
      this.db
        .prepare(
          `INSERT INTO candidates
             (candidate_id, cycle_id, round, owner, repo, pr_number, head_sha, reason, source_id,
              installation_id, status, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          candidateId,
          input.cycleId,
          input.round,
          input.owner,
          input.repo,
          input.prNumber,
          input.headSha,
          input.reason,
          input.sourceId,
          input.installationId,
          this.now().toISOString(),
        );
      return { candidateId, duplicate: false };
    });
  }

  /**
   * reviewer の起動を記録し、cycle・round・HEAD を束縛して返す。
   * 取消済み（要求中を含む）の候補は起動しない。
   */
  start(candidateId: string): CandidateBinding {
    return this.transaction(() => {
      const row = this.requireCandidate(candidateId);
      if (this.cancellation(row.cycle_id)) {
        throw new ContractError("CANDIDATE_CANCELLED", "取消済みの候補は起動しない");
      }
      if (row.status === "queued") {
        this.db
          .prepare(
            "UPDATE candidates SET status = 'started', started_at = ? WHERE candidate_id = ?",
          )
          .run(this.now().toISOString(), candidateId);
      }
      return bindingOf(row);
    });
  }

  /**
   * GitHub への結果投稿を始める印を付ける。取消済みの候補には投稿させない。
   * 投稿が進行中または結果不明の間は、取消を確定しない（照合前に ACK を返さない）。
   */
  beginResultWrite(candidateId: string, kind: ResultKind): CandidateBinding & { writeId: string } {
    return this.transaction(() => {
      const row = this.requireCandidate(candidateId);
      if (this.cancellation(row.cycle_id)) {
        throw new ContractError("CANDIDATE_CANCELLED", "取消済みの候補は投稿しない");
      }
      if (row.write_state === "in-progress") {
        throw new ContractError(
          "UNAVAILABLE",
          "この候補の GitHub 書込みが進行中または結果不明のため、照合が済むまで始めない",
        );
      }
      const writeId = this.newWriteId();
      this.db
        .prepare(
          "UPDATE candidates SET write_state = 'in-progress', write_id = ?, write_kind = ? WHERE candidate_id = ?",
        )
        .run(writeId, kind, candidateId);
      return { ...bindingOf(row), writeId };
    });
  }

  /**
   * GitHub への投稿が成功した（または照合で実在を確認した）結果を索引に記録する。
   * 取消の要求中でも、実在する投稿は記録する。同じ投稿の再記録は同じ版を返す。
   */
  recordResultPosted(candidateId: string, posted: ResultPost): ReviewResult {
    return this.transaction(() => {
      const row = this.requireCandidate(candidateId);
      if (posted.headSha !== row.head_sha) {
        throw new ContractError(
          "RESULT_HEAD_MISMATCH",
          "結果の HEAD が候補の HEAD と異なるため、記録しない",
        );
      }
      const same = this.db
        .prepare(
          `SELECT result_version, kind, head_sha, comment_id, url FROM results
           WHERE cycle_id = ? AND comment_id = ?`,
        )
        .get(row.cycle_id, posted.post.commentId) as ResultRow | undefined;
      if (same) {
        return resultOf(same);
      }
      // 版は候補ごとの単調増加の採番で、結果索引の保持期限による削除後も戻らない
      // （索引だけが消えても、残っている通知の版や raven が持つ版と衝突させない）。
      const version = row.last_result_version + 1;
      this.db
        .prepare("UPDATE candidates SET last_result_version = ? WHERE candidate_id = ?")
        .run(version, candidateId);
      this.db
        .prepare(
          `INSERT INTO results
             (cycle_id, result_version, candidate_id, kind, head_sha, comment_id, url, posted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.cycle_id,
          version,
          candidateId,
          posted.kind,
          posted.headSha,
          posted.post.commentId,
          posted.post.url,
          posted.postedAt,
        );
      this.db
        .prepare(
          `UPDATE candidates SET write_state = 'idle', write_id = NULL, write_kind = NULL
           WHERE candidate_id = ? AND (? IS NULL OR write_id = ?)`,
        )
        .run(candidateId, posted.writeId ?? null, posted.writeId ?? null);
      // 結果の記録と同じトランザクションで outbox に積む（記録したのに通知が積まれない状態を作らない）。
      this.db
        .prepare(
          `INSERT INTO result_outbox
             (cycle_id, result_version, candidate_id, kind, head_sha, comment_id, url, posted_at,
              next_attempt_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.cycle_id,
          version,
          candidateId,
          posted.kind,
          posted.headSha,
          posted.post.commentId,
          posted.post.url,
          posted.postedAt,
          this.now().toISOString(),
        );
      return {
        source: "thread-owl",
        kind: posted.kind,
        headSha: posted.headSha,
        resultVersion: version,
        post: posted.post,
      };
    });
  }

  /**
   * 照合で GitHub に投稿が無いと確認できたとき、その書込みの進行中を解除する。
   * 照合している間に別の書込みが始まっていた場合（writeId が違う）は、何も変えない。
   */
  abortResultWrite(candidateId: string, writeId: string): void {
    this.transaction(() => {
      this.requireCandidate(candidateId);
      this.db
        .prepare(
          "UPDATE candidates SET write_state = 'idle', write_id = NULL, write_kind = NULL WHERE candidate_id = ? AND write_id = ?",
        )
        .run(candidateId, writeId);
    });
  }

  /**
   * 旧候補を無効化する。未受理の cycle にも永続の取消記録を残す。
   * - 結果の投稿が先に確定していれば CANCEL_RESULT_POSTED（結果は取り消さない）
   * - GitHub 書込みが進行中・結果不明なら CANCEL_UNCONFIRMED（記録は残し、起動と投稿は拒否する）
   */
  cancel(input: CancelInput): { cancelId: string; candidateStatus: CandidateStatus } {
    return this.transaction(() => {
      const candidate = this.candidateByCycle(input.cycleId);
      const previous = this.cancellation(input.cycleId);

      if (previous && previous.head_sha !== input.headSha) {
        throw new ContractError("HEAD_CONFLICT", "取消記録の HEAD と異なる");
      }
      if (candidate) {
        if (candidate.head_sha !== input.headSha) {
          throw new ContractError("HEAD_CONFLICT", "候補の HEAD と異なる");
        }
        if (candidate.round !== input.round) {
          throw new ContractError("INVALID_ARGUMENT", "候補の round と異なる");
        }
        if (this.latestResult(input.cycleId)) {
          // 投稿が先着した。要求中の取消記録は撤回する（結果を取消扱いにしない）。
          this.db.prepare("DELETE FROM cancellations WHERE cycle_id = ?").run(input.cycleId);
          return new ContractError(
            "CANCEL_RESULT_POSTED",
            "結果の投稿が先に確定しているため、取消は確定しない",
          );
        }
      }

      const now = this.now().toISOString();
      if (candidate?.write_state === "in-progress") {
        if (!previous) {
          this.db
            .prepare(
              `INSERT INTO cancellations (cycle_id, cancel_id, round, head_sha, state, requested_at)
               VALUES (?, ?, ?, ?, 'requested', ?)`,
            )
            .run(input.cycleId, input.cancelId, input.round, input.headSha, now);
        }
        return new ContractError(
          "CANCEL_UNCONFIRMED",
          "GitHub 書込みが進行中または結果不明のため、照合が済むまで取消を確定しない",
        );
      }

      if (!previous) {
        this.db
          .prepare(
            `INSERT INTO cancellations
               (cycle_id, cancel_id, round, head_sha, state, requested_at, confirmed_at)
             VALUES (?, ?, ?, ?, 'confirmed', ?, ?)`,
          )
          .run(input.cycleId, input.cancelId, input.round, input.headSha, now, now);
      } else if (previous.state === "requested") {
        this.db
          .prepare(
            "UPDATE cancellations SET state = 'confirmed', confirmed_at = ? WHERE cycle_id = ?",
          )
          .run(now, input.cycleId);
      }
      return {
        cancelId: input.cancelId,
        candidateStatus: candidate ? candidate.status : "not-accepted",
      };
    });
  }

  private countQueued(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM candidates
         WHERE status = 'queued'
           AND NOT EXISTS (SELECT 1 FROM cancellations c WHERE c.cycle_id = candidates.cycle_id)`,
      )
      .get() as { n: number };
    return row.n;
  }

  /** cycle の候補に、進行中（または結果不明）の GitHub 書込みがあれば返す。 */
  pendingWriteByCycle(cycleId: string): PendingWrite | undefined {
    const row = this.candidateByCycle(cycleId);
    if (row?.write_state !== "in-progress" || row.write_id === null || row.write_kind === null) {
      return undefined;
    }
    return { ...bindingOf(row), writeId: row.write_id, kind: row.write_kind };
  }

  /** 受付済みで未起動、かつ取消記録のない候補を、受付順に返す。 */
  listQueued(): QueuedCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM candidates
         WHERE status = 'queued'
           AND NOT EXISTS (SELECT 1 FROM cancellations c WHERE c.cycle_id = candidates.cycle_id)
         ORDER BY accepted_at, rowid`,
      )
      .all() as unknown as CandidateRow[];
    return rows.map((row) => ({
      ...bindingOf(row),
      installationId: row.installation_id,
      reason: row.reason as CandidateReason,
      acceptedAt: row.accepted_at,
    }));
  }

  /** 送信の期限が来た結果の通知を、古い順に返す。 */
  dueResultMessages(limit = 50): DueResultMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM result_outbox
         WHERE state = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, rowid LIMIT ?`,
      )
      .all(this.now().toISOString(), limit) as unknown as OutboxRow[];
    return rows.map((row) => ({
      attempts: row.attempts,
      message: {
        cycleId: row.cycle_id,
        candidateId: row.candidate_id,
        headSha: row.head_sha,
        resultVersion: row.result_version,
        kind: row.kind,
        post: { commentId: row.comment_id, url: row.url },
        postedAt: row.posted_at,
      },
    }));
  }

  /** 送信に成功した（raven が受理した、または重複として受理した）。 */
  markResultDelivered(cycleId: string, resultVersion: number): void {
    this.finishResult(cycleId, resultVersion, "delivered", null);
  }

  /** raven が再送しても通らない理由で拒否した（取消済み・期限切れ・権限など）。再送しない。 */
  markResultRejected(cycleId: string, resultVersion: number, code: string): void {
    this.finishResult(cycleId, resultVersion, "rejected", code);
  }

  /**
   * 送信に失敗した（ACK 未受信など）。次の試行の時刻を渡すと再送に回し、null なら試行上限として諦める
   * （failed。自動で別の経路へ切り替えない）。
   */
  recordResultDeliveryFailure(
    cycleId: string,
    resultVersion: number,
    failure: { code: string; nextAttemptAt: Date | null },
  ): void {
    if (failure.nextAttemptAt === null) {
      this.db
        .prepare(
          `UPDATE result_outbox SET attempts = attempts + 1, last_error = ?, state = 'failed', finished_at = ?
           WHERE cycle_id = ? AND result_version = ? AND state = 'pending'`,
        )
        .run(failure.code, this.now().toISOString(), cycleId, resultVersion);
      return;
    }
    this.db
      .prepare(
        `UPDATE result_outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
         WHERE cycle_id = ? AND result_version = ? AND state = 'pending'`,
      )
      .run(failure.code, failure.nextAttemptAt.toISOString(), cycleId, resultVersion);
  }

  private finishResult(
    cycleId: string,
    resultVersion: number,
    state: "delivered" | "rejected",
    error: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE result_outbox SET state = ?, last_error = ?, attempts = attempts + 1, finished_at = ?
         WHERE cycle_id = ? AND result_version = ? AND state = 'pending'`,
      )
      .run(state, error, this.now().toISOString(), cycleId, resultVersion);
  }

  /**
   * webhook・コメント由来の候補の通知を積む。同じ sourceId（配送の再送など）は積み直さない。
   * 積んだら true、すでに積まれていたら false。
   */
  enqueueIngest(message: IngestMessage): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO ingest_outbox
           (source_id, owner, repo, pr_number, head_sha, reason, delivery, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.sourceId,
        message.owner,
        message.repo,
        message.prNumber,
        message.headSha,
        message.reason,
        message.delivery,
        this.now().toISOString(),
      );
    return result.changes > 0;
  }

  /** 送信の期限が来た候補の通知を、古い順に返す。 */
  dueIngestMessages(limit = 50): DueIngestMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ingest_outbox
         WHERE state = 'pending' AND next_attempt_at <= ?
         ORDER BY next_attempt_at, rowid LIMIT ?`,
      )
      .all(this.now().toISOString(), limit) as unknown as IngestRow[];
    return rows.map((row) => ({
      attempts: row.attempts,
      message: {
        sourceId: row.source_id,
        owner: row.owner,
        repo: row.repo,
        prNumber: row.pr_number,
        headSha: row.head_sha,
        reason: row.reason,
        delivery: row.delivery,
      },
    }));
  }

  markIngestDelivered(sourceId: string): void {
    this.finishIngest(sourceId, "delivered", null);
  }

  /** raven が再送しても通らない理由で拒否した（権限・schema 競合など）。再送しない。 */
  markIngestRejected(sourceId: string, code: string): void {
    this.finishIngest(sourceId, "rejected", code);
  }

  /** 結果の通知と同じ。nextAttemptAt が null なら試行上限として諦める（failed）。 */
  recordIngestDeliveryFailure(
    sourceId: string,
    failure: { code: string; nextAttemptAt: Date | null },
  ): void {
    if (failure.nextAttemptAt === null) {
      this.db
        .prepare(
          `UPDATE ingest_outbox SET attempts = attempts + 1, last_error = ?, state = 'failed', finished_at = ?
           WHERE source_id = ? AND state = 'pending'`,
        )
        .run(failure.code, this.now().toISOString(), sourceId);
      return;
    }
    this.db
      .prepare(
        `UPDATE ingest_outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?
         WHERE source_id = ? AND state = 'pending'`,
      )
      .run(failure.code, failure.nextAttemptAt.toISOString(), sourceId);
  }

  private finishIngest(
    sourceId: string,
    state: "delivered" | "rejected",
    error: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE ingest_outbox SET state = ?, last_error = ?, attempts = attempts + 1, finished_at = ?
         WHERE source_id = ? AND state = 'pending'`,
      )
      .run(state, error, this.now().toISOString(), sourceId);
  }

  /**
   * 保持期限（日）を過ぎた行を削除する。各表は自分の時計で数え、互いに独立:
   * - 取消記録は、確定（confirmed）した時刻から数える。要求中（requested）の取消は削除しない
   *   （旧候補の起動・投稿を拒否し続けるため）。
   * - 結果索引は、投稿の時刻から数える。
   * - outbox は、送信を終えた（delivered・rejected・failed）時刻から数える。送信待ち（pending）は削除しない。
   * - 候補は、受付から期限を過ぎ、書込みが進行中でなく、結果・取消記録・送信待ちの通知がどれも残っていないものだけ削除する。
   */
  purgeExpired(retentionDays: number): PurgeReport {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000).toISOString();
    return this.transaction(() => {
      const run = (sql: string): number => Number(this.db.prepare(sql).run(cutoff).changes);
      const resultOutbox = run(
        "DELETE FROM result_outbox WHERE state != 'pending' AND julianday(finished_at) < julianday(?)",
      );
      const ingestOutbox = run(
        "DELETE FROM ingest_outbox WHERE state != 'pending' AND julianday(finished_at) < julianday(?)",
      );
      const cancellations = run(
        "DELETE FROM cancellations WHERE state = 'confirmed' AND julianday(confirmed_at) < julianday(?)",
      );
      const results = run("DELETE FROM results WHERE julianday(posted_at) < julianday(?)");
      const expired = this.db
        .prepare(
          `SELECT cycle_id FROM candidates
           WHERE julianday(accepted_at) < julianday(?)
             AND write_state = 'idle'
             AND NOT EXISTS (SELECT 1 FROM results r WHERE r.cycle_id = candidates.cycle_id)
             AND NOT EXISTS (SELECT 1 FROM cancellations c WHERE c.cycle_id = candidates.cycle_id)
             AND NOT EXISTS (
               SELECT 1 FROM result_outbox o
               WHERE o.cycle_id = candidates.cycle_id AND o.state = 'pending'
             )`,
        )
        .all(cutoff) as Array<{ cycle_id: string }>;
      const remove = this.db.prepare("DELETE FROM candidates WHERE cycle_id = ?");
      for (const { cycle_id } of expired) {
        remove.run(cycle_id);
      }
      return {
        purgedCycleIds: expired.map((c) => c.cycle_id),
        candidates: expired.length,
        results,
        cancellations,
        resultOutbox,
        ingestOutbox,
      };
    });
  }

  /** 候補の同一性を、状態を変えずに読む。 */
  getCandidate(candidateId: string): CandidateBinding | undefined {
    const row = this.candidateById(candidateId);
    return row ? bindingOf(row) : undefined;
  }

  /** cycle の受付済み候補。repo が入力に無い操作（取消・結果参照）で、対象 repo の認可に使う。 */
  findByCycle(cycleId: string): CandidateBinding | undefined {
    const row = this.candidateByCycle(cycleId);
    return row ? bindingOf(row) : undefined;
  }

  /** 結果の参照を返す。まだ無ければ null。cycle と candidateId の組が受付済みでなければ REQUEST_NOT_FOUND。 */
  getResult(cycleId: string, candidateId: string): ReviewResult | null {
    const row = this.candidateById(candidateId);
    if (!row || row.cycle_id !== cycleId) {
      throw new ContractError("REQUEST_NOT_FOUND", "cycle と candidate の組が見つからない");
    }
    const latest = this.latestResult(cycleId);
    return latest ? resultOf(latest) : null;
  }

  /**
   * 書込みを 1 トランザクションで行う。throw された契約エラーは副作用ごと巻き戻す。
   * 書込みを残したままエラーを返すもの（取消の保留など）は、エラーを throw せず return する:
   * COMMIT した後に throw する。
   */
  private transaction<T>(fn: () => T | ContractError): T {
    this.db.exec("BEGIN IMMEDIATE");
    let outcome: T | ContractError;
    try {
      outcome = fn();
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("COMMIT");
    if (outcome instanceof ContractError) {
      throw outcome;
    }
    return outcome;
  }

  private requireCandidate(candidateId: string): CandidateRow {
    const row = this.candidateById(candidateId);
    if (!row) {
      throw new ContractError("REQUEST_NOT_FOUND", "候補が見つからない");
    }
    return row;
  }

  private candidateById(candidateId: string): CandidateRow | undefined {
    return this.db.prepare("SELECT * FROM candidates WHERE candidate_id = ?").get(candidateId) as
      | CandidateRow
      | undefined;
  }

  private candidateByCycle(cycleId: string): CandidateRow | undefined {
    return this.db.prepare("SELECT * FROM candidates WHERE cycle_id = ?").get(cycleId) as
      | CandidateRow
      | undefined;
  }

  private cancellation(cycleId: string): CancellationRow | undefined {
    return this.db.prepare("SELECT * FROM cancellations WHERE cycle_id = ?").get(cycleId) as
      | CancellationRow
      | undefined;
  }

  private latestResult(cycleId: string): ResultRow | undefined {
    return this.db
      .prepare(
        `SELECT result_version, kind, head_sha, comment_id, url FROM results
         WHERE cycle_id = ? ORDER BY result_version DESC LIMIT 1`,
      )
      .get(cycleId) as ResultRow | undefined;
  }

  private assertSameCandidate(existing: CandidateRow, input: AcceptInput): void {
    if (existing.head_sha !== input.headSha) {
      throw new ContractError("HEAD_CONFLICT", "同じ cycle に異なる HEAD の候補は受け付けない");
    }
    const same =
      existing.round === input.round &&
      existing.owner === input.owner &&
      existing.repo === input.repo &&
      existing.pr_number === input.prNumber &&
      existing.reason === input.reason &&
      existing.source_id === input.sourceId;
    if (!same) {
      throw new ContractError("INVALID_ARGUMENT", "同じ cycle に異なる内容の候補は受け付けない");
    }
  }
}

function bindingOf(row: CandidateRow): CandidateBinding {
  return {
    candidateId: row.candidate_id,
    cycleId: row.cycle_id,
    round: row.round,
    owner: row.owner,
    repo: row.repo,
    prNumber: row.pr_number,
    headSha: row.head_sha,
  };
}

function resultOf(row: ResultRow): ReviewResult {
  return {
    source: "thread-owl",
    kind: row.kind,
    headSha: row.head_sha,
    resultVersion: row.result_version,
    post: { commentId: row.comment_id, url: row.url },
  };
}
