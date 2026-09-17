import { describe, expect, it } from "vitest";
import {
  assertFullCommitSha,
  assertVerdictSummary,
  buildVerdictBody,
  InvalidVerdictInputError,
} from "../../../src/github/review-verdict.js";

const HEAD_SHA = "3facb641b17b1f31e9fb1895b558548cd48dcb78";

// Mcp-Docker の「Verdict 照合規則」の正規表現。両者がずれると reviewed 側のマージゲートが
// VERDICT_FORMAT_MISMATCH で止まるため、組み立て結果をこの規則で直接検証する。
const MATCH_RULE = [
  /^## @thread-owl Review Verdict: APPROVED$/,
  /^- Reviewed HEAD SHA: `([0-9a-f]{40})`$/,
  /^- Status: `READY_TO_MERGE`$/,
] as const;

// 照合規則と同じ行分割（`\n` で分割し、各行末尾の `\r` を 1 個だけ除去する）。
function splitLines(body: string): string[] {
  return body.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function matchRule(body: string): { ok: boolean; sha?: string } {
  const lines = splitLines(body);
  const indexes: number[] = [];
  let sha: string | undefined;
  for (const [i, pattern] of MATCH_RULE.entries()) {
    const hits = lines.filter((line) => pattern.test(line));
    if (hits.length !== 1) return { ok: false };
    indexes.push(lines.findIndex((line) => pattern.test(line)));
    if (i === 1) sha = pattern.exec(hits[0])?.[1];
  }
  // 見出し行が他の 2 行より前にあること。
  if (!(indexes[0] < indexes[1] && indexes[0] < indexes[2])) return { ok: false };
  return { ok: true, sha };
}

describe("buildVerdictBody", () => {
  it.each([
    { name: "単一行の summary", summary: "マージ可能と判定しました。" },
    {
      name: "見出し・箇条書きを含む summary",
      summary: "### レビューサマリー\n- **主な確認観点**:\n  - CI 13 件すべて success",
    },
    { name: "前後に空行がある summary", summary: "\n\n判定根拠は以下のとおり。\n\n" },
    { name: "--- を含む summary", summary: "前半\n\n---\n\n後半" },
    { name: "バッククォートを含む summary", summary: "`gh api` の fallback を確認しました。" },
    { name: "READY_TO_MERGE の語を含む summary", summary: "reviewed 側は READY_TO_MERGE になる" },
    { name: "APPROVED の語を含む summary", summary: "APPROVED 相当と判断した" },
  ])("$name から照合規則に一致する本文を組み立てる", ({ summary }) => {
    const body = buildVerdictBody(summary, HEAD_SHA);

    const result = matchRule(body);
    expect(result.ok).toBe(true);
    expect(result.sha).toBe(HEAD_SHA);
  });

  it("固定部分を規則どおりの順序と書式で組み立てる", () => {
    const body = buildVerdictBody("本文", HEAD_SHA);

    expect(body).toBe(
      [
        "## @thread-owl Review Verdict: APPROVED",
        "",
        "本文",
        "",
        "---",
        `- Reviewed HEAD SHA: \`${HEAD_SHA}\``,
        "- Status: `READY_TO_MERGE`",
      ].join("\n"),
    );
  });
});

describe("assertFullCommitSha", () => {
  it("40 桁の小文字 hex を受け付ける", () => {
    expect(() => assertFullCommitSha(HEAD_SHA)).not.toThrow();
  });

  it.each([
    { name: "branch 名", headSha: "main" },
    { name: "短縮 SHA", headSha: "3facb64" },
    { name: "大文字を含む", headSha: HEAD_SHA.toUpperCase() },
    { name: "41 桁", headSha: `${HEAD_SHA}a` },
    { name: "hex 以外を含む", headSha: `${HEAD_SHA.slice(0, 39)}z` },
    { name: "空文字", headSha: "" },
  ])("$name を拒否する", ({ headSha }) => {
    expect(() => assertFullCommitSha(headSha)).toThrow(InvalidVerdictInputError);
  });
});

describe("assertVerdictSummary", () => {
  it.each([
    { name: "通常の本文", summary: "CI は 13 件すべて success でした。" },
    { name: "Verdict の語だけを含む", summary: "Verdict の根拠を示します" },
    { name: "Status の語だけを含む", summary: "Status は問題ありません" },
    { name: "行頭が異なる HEAD SHA 行", summary: `Reviewed HEAD SHA: \`${HEAD_SHA}\`` },
  ])("$name を受け付ける", ({ summary }) => {
    expect(() => assertVerdictSummary(summary)).not.toThrow();
  });

  it.each([
    { name: "見出し行", summary: "## @thread-owl Review Verdict: APPROVED" },
    { name: "HEAD SHA 行", summary: `- Reviewed HEAD SHA: \`${HEAD_SHA}\`` },
    { name: "Status 行", summary: "- Status: `READY_TO_MERGE`" },
    { name: "本文中の Review Verdict", summary: "前回の Review Verdict を参照" },
    { name: "崩れた見出し", summary: "## @thread-owl Review Verdict: READY_TO_MERGE" },
    { name: "複数行のうち 1 行が固定行", summary: `前段\n- Status: \`READY_TO_MERGE\`\n後段` },
    { name: "CRLF 改行の固定行", summary: "前段\r\n- Status: `READY_TO_MERGE`\r\n後段" },
  ])("$name を拒否する", ({ summary }) => {
    expect(() => assertVerdictSummary(summary)).toThrow(InvalidVerdictInputError);
  });
});
