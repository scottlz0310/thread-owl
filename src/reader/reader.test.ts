import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { clampMessage, toErrorEnvelope, toOutput } from "./output.js";
import {
  CODE_AUTHOR_CHECK_FAILED,
  CODE_PROJECT_ALLOWLIST_INVALID,
  CODE_SNAPSHOT_CHANGED,
  CODE_TRUSTED_AUTHORS_NOT_CONFIGURED,
  CODE_UNTRUSTED_COMMENT,
  type CommentKind,
  MAX_MESSAGE_LENGTH,
  ProjectAllowlistInvalidError,
  type ReaderComment,
  ReaderGateError,
  type ReaderSnapshot,
  type ReaderSource,
  readComments,
  SnapshotMovedError,
  snapshotId,
} from "./reader.js";

// ─── 共有シナリオ（review-raven の docs/design/contracts/reader を固定して取り込んだもの） ───

const contractDir = fileURLToPath(new URL("../contract/v1/reader/", import.meta.url));

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(`${contractDir}${file}`, "utf8")) as T;
}

interface FixtureComment {
  id: string;
  author: string;
  authorType: string;
  url: string;
  createdAt: string;
  editedAt: string | null;
  state?: string;
  body: string;
}

interface FixtureFetch {
  moved?: boolean;
  headSha: string;
  baseSha: string;
  threads: {
    id: string;
    path: string;
    line: number | null;
    isResolved: boolean;
    isOutdated: boolean;
    comments: FixtureComment[];
  }[];
  reviews: FixtureComment[];
  issueComments: FixtureComment[];
}

interface Scenario {
  name: string;
  description: string;
  serverAllowlist: string[];
  projectAllowlist: { state: "absent" | "present" | "invalid"; logins?: string[] };
  fetches: FixtureFetch[];
  expect: {
    outcome: "ok" | "error";
    code?: string;
    fetchCalls: number;
    bodyFetchCalls: number;
    commentIds?: string[];
    errorCommentIds?: string[];
    allowlist?: { serverLogins: number; projectFile: boolean; projectLogins: number };
  };
}

const scenarios = readJson<{ schemaVersion: number; scenarios: Scenario[] }>("scenarios.json");

function toComment(kind: CommentKind, c: FixtureComment, withBody: boolean): ReaderComment {
  return {
    kind,
    id: c.id,
    author: c.author,
    authorType: c.authorType,
    url: c.url,
    createdAt: c.createdAt,
    editedAt: c.editedAt ?? "",
    state: c.state ?? "",
    body: withBody ? c.body : null,
  };
}

function toSnapshot(f: FixtureFetch, withBodies: boolean): ReaderSnapshot {
  return {
    headSha: f.headSha,
    baseSha: f.baseSha,
    threads: f.threads.map((t) => ({
      id: t.id,
      path: t.path,
      line: t.line,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.map((c) => toComment("review_thread_comment", c, withBodies)),
    })),
    reviews: f.reviews.map((c) => toComment("review_body", c, withBodies)),
    issueComments: f.issueComments.map((c) => toComment("issue_comment", c, withBodies)),
  };
}

// シナリオの取得結果を順に返す。メタデータの呼び出しには本文を除いて返す
// （GitHub に本文を選択させない問い合わせの応答を模す）。
class ScriptedSource implements ReaderSource {
  calls = 0;
  bodyCalls = 0;

  constructor(private readonly scenario: Scenario) {}

  async fetch(withBodies: boolean): Promise<ReaderSnapshot> {
    const entry = this.scenario.fetches[this.calls];
    if (entry === undefined) {
      throw new Error(
        `unexpected fetch #${this.calls + 1} (withBodies=${withBodies}): the scenario scripts only ${this.scenario.fetches.length}`,
      );
    }
    this.calls++;
    if (withBodies) this.bodyCalls++;
    if (entry.moved) throw new SnapshotMovedError();
    return toSnapshot(entry, withBodies);
  }

  async projectAllowlist() {
    const p = this.scenario.projectAllowlist;
    if (p.state === "invalid")
      throw new ProjectAllowlistInvalidError("project allowlist is invalid");
    if (p.state === "present") return { state: "present" as const, logins: p.logins ?? [] };
    return { state: "absent" as const };
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateOutput = ajv.compile(readJson<object>("read_pr_comments.output.schema.json"));
const validateError = ajv.compile(readJson<object>("read_pr_comments.error.schema.json"));

function keys(snapshot: ReaderSnapshot): string[] {
  return [
    ...snapshot.threads.flatMap((t) => t.comments),
    ...snapshot.reviews,
    ...snapshot.issueComments,
  ]
    .map((c) => `${c.kind}:${c.id}`)
    .sort();
}

function allBodies(s: Scenario): string[] {
  return s.fetches.flatMap((f) =>
    [...f.threads.flatMap((t) => t.comments), ...f.reviews, ...f.issueComments].map((c) => c.body),
  );
}

describe("shared reader scenarios", () => {
  test("the pinned scenarios file is the expected version", () => {
    expect(scenarios.schemaVersion).toBe(1);
    expect(scenarios.scenarios.length).toBeGreaterThan(0);
  });

  test.each(scenarios.scenarios.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const source = new ScriptedSource(scenario);
    const outcome = await readComments(source, scenario.serverAllowlist).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );

    expect([source.calls, source.bodyCalls]).toEqual([
      scenario.expect.fetchCalls,
      scenario.expect.bodyFetchCalls,
    ]);

    if (scenario.expect.outcome === "ok") {
      if ("error" in outcome) throw outcome.error;
      const { result } = outcome;
      expect(keys(result.snapshot)).toEqual([...(scenario.expect.commentIds ?? [])].sort());
      if (scenario.expect.allowlist) expect(result.allowlist).toEqual(scenario.expect.allowlist);
      const output = toOutput(result);
      expect(validateOutput(output), JSON.stringify(validateOutput.errors)).toBe(true);
      return;
    }

    if ("result" in outcome) throw new Error("expected the reader to stop");
    const error = outcome.error;
    expect(error).toBeInstanceOf(ReaderGateError);
    const gate = error as ReaderGateError;
    expect(gate.code).toBe(scenario.expect.code);
    expect(gate.comments.map((c) => `${c.kind}:${c.id}`).sort()).toEqual(
      [...(scenario.expect.errorCommentIds ?? [])].sort(),
    );
    const envelope = toErrorEnvelope(gate);
    expect(validateError(envelope), JSON.stringify(validateError.errors)).toBe(true);

    // 失敗の応答に、どのコメントの本文も含まれない。
    const raw = JSON.stringify(envelope);
    for (const body of allBodies(scenario)) {
      if (body !== "") expect(raw).not.toContain(body);
    }
  });

  // 検証で止まったシナリオでは、本文を要求した回数が、検証を通過した試行の分だけである。
  // 取り直した試行は「メタデータ→本文」の組、最後に止まった試行は「メタデータ」だけなので、
  // メタデータの呼び出し回数 = 本文の呼び出し回数 + 1 になる（GitHub を呼ばずに止まる場合は 0 回）。
  test.each(
    scenarios.scenarios.filter((s) =>
      [CODE_UNTRUSTED_COMMENT, CODE_AUTHOR_CHECK_FAILED, CODE_PROJECT_ALLOWLIST_INVALID].includes(
        s.expect.code ?? "",
      ),
    ),
  )("a blocked attempt never asks for text: $name", (scenario) => {
    expect(scenario.expect.fetchCalls).toBe(2 * scenario.expect.bodyFetchCalls + 1);
  });

  test("an empty server allowlist stops before calling GitHub", async () => {
    const scenario = scenarios.scenarios.find(
      (s) => s.expect.code === CODE_TRUSTED_AUTHORS_NOT_CONFIGURED,
    );
    expect(scenario?.expect.fetchCalls).toBe(0);
  });
});

describe("error messages stay within the contract", () => {
  test.each([
    ["501 ascii characters", "x".repeat(501)],
    ["2000 multibyte characters", "あ".repeat(2000)],
    ["astral characters (surrogate pairs)", "😀".repeat(900)],
    ["exactly 500 characters", "x".repeat(500)],
  ])("%s", (_name, message) => {
    const error = new ReaderGateError(CODE_SNAPSHOT_CHANGED, message);
    const envelope = toErrorEnvelope(error);
    const chars = Array.from(envelope.error.message);
    expect(chars.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    // サロゲートペアの途中で切っていない
    expect(envelope.error.message).not.toMatch(/[\uD800-\uDBFF]$/);
    if (Array.from(message).length <= MAX_MESSAGE_LENGTH) {
      expect(envelope.error.message).toBe(message);
    }
    expect(validateError(envelope), JSON.stringify(validateError.errors)).toBe(true);
  });

  test("clampMessage leaves a short message alone", () => {
    expect(clampMessage("short")).toBe("short");
  });
});

describe("snapshotId", () => {
  const base = (): ReaderSnapshot => ({
    headSha: "1".repeat(40),
    baseSha: "2".repeat(40),
    threads: [],
    reviews: [],
    issueComments: [
      {
        kind: "issue_comment",
        id: "2",
        author: "thread-owl",
        authorType: "Bot",
        url: "",
        createdAt: "",
        editedAt: "",
        state: "",
        body: "b",
      },
      {
        kind: "issue_comment",
        id: "1",
        author: "thread-owl",
        authorType: "Bot",
        url: "",
        createdAt: "",
        editedAt: "",
        state: "",
        body: "a",
      },
    ],
  });

  test("is 64 lowercase hex characters", () => {
    expect(snapshotId(base())).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    [
      "order does not matter",
      (s: ReaderSnapshot) => {
        s.issueComments.reverse();
      },
      true,
    ],
    [
      "body text is not part of the id (edits are tracked by editedAt)",
      (s: ReaderSnapshot) => {
        s.issueComments[0].body = "changed";
      },
      true,
    ],
    [
      "edit timestamp",
      (s: ReaderSnapshot) => {
        s.issueComments[0].editedAt = "2026-10-25T01:00:00Z";
      },
      false,
    ],
    [
      "head moved",
      (s: ReaderSnapshot) => {
        s.headSha = "3".repeat(40);
      },
      false,
    ],
    [
      "author changed",
      (s: ReaderSnapshot) => {
        s.issueComments[0].author = "mallory";
      },
      false,
    ],
    [
      "comment added",
      (s: ReaderSnapshot) => {
        s.issueComments.push({ ...s.issueComments[0], id: "9" });
      },
      false,
    ],
  ])("%s", (_name, mutate, wantSame) => {
    const changed = base();
    mutate(changed);
    expect(snapshotId(changed) === snapshotId(base())).toBe(wantSame);
  });

  // review-raven（Go）と同じ値になる。コメントの並びは UTF-8 のバイト順で比べる。
  test("matches the value computed by the review-raven implementation for the same snapshot", () => {
    const s = base();
    s.issueComments = [
      { ...s.issueComments[0], id: "1", author: "a", authorType: "Bot" },
      { ...s.issueComments[0], id: "2", author: "あ", authorType: "Bot" },
      { ...s.issueComments[0], id: "3", author: "😀", authorType: "Bot" },
    ];
    // 先頭 2 行 + バイト順に並べたコメント 3 行
    const expected = [
      `head=${"1".repeat(40)}`,
      `base=${"2".repeat(40)}`,
      "issue_comment|1||a|Bot|",
      "issue_comment|2||あ|Bot|",
      "issue_comment|3||😀|Bot|",
    ].join("\n");
    expect(snapshotId(s)).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
    // review-raven の Go 実装（internal/reader の snapshotID）で同じ入力から計算した値。
    expect(snapshotId(s)).toBe("2bec2b0eaf46b93771d1c2dd5e985deae78010e3ef9e09575d4ec9a03d900e21");
  });
});
