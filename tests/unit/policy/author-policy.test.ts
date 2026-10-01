import { describe, expect, it } from "vitest";
import {
  evaluatePullRequestOrigin,
  isAuthorAllowed,
  normalizeLogin,
  PullRequestOriginNotAllowedError,
  parseAuthorAllowlist,
} from "../../../src/policy/author-policy.js";

describe("normalizeLogin", () => {
  it.each([
    { login: "scottlz0310-user", expected: "scottlz0310-user" },
    { login: "ScottLz0310-User", expected: "scottlz0310-user" },
    { login: "thread-owl[bot]", expected: "thread-owl" },
    { login: "THREAD-OWL[BOT]", expected: "thread-owl" },
    // suffix を取り除くのは 1 回だけ
    { login: "thread-owl[bot][bot]", expected: "thread-owl[bot]" },
    // 途中の [bot] や、前後の空白は扱わない
    { login: "a[bot]b", expected: "a[bot]b" },
    { login: " alice ", expected: " alice " },
  ])("$login → $expected", ({ login, expected }) => {
    expect(normalizeLogin(login)).toBe(expected);
  });
});

describe("parseAuthorAllowlist", () => {
  it.each([
    { name: "空文字は未設定（空配列）", raw: "", expected: [] },
    { name: "空白だけ・空エントリは除外", raw: " , ,", expected: [] },
    { name: "単一の login", raw: "alice", expected: ["alice"] },
    { name: "トリム・小文字化・重複除去", raw: " Alice , alice,BOB ", expected: ["alice", "bob"] },
    {
      name: "bot 名義は [bot] を取り除く（有無を重複して書かない）",
      raw: "mcp-gateway-authentication-app[bot],mcp-gateway-authentication-app",
      expected: ["mcp-gateway-authentication-app"],
    },
    { name: "数字・ハイフンを含む login", raw: "scottlz0310-user", expected: ["scottlz0310-user"] },
  ])("$name", ({ raw, expected }) => {
    expect(parseAuthorAllowlist(raw)).toEqual(expected);
  });

  it.each([
    { name: "wildcard", raw: "*" },
    { name: "owner/repo 形式", raw: "owner/repo" },
    { name: "先頭がハイフン", raw: "-alice" },
    { name: "末尾がハイフン", raw: "alice-" },
    { name: "空白を含む", raw: "al ice" },
    { name: "[bot] の二重 suffix", raw: "thread-owl[bot][bot]" },
    { name: "一部だけ不正", raw: "alice,bad/entry" },
  ])("形式不正は fail-fast で throw する: $name", ({ raw }) => {
    expect(() => parseAuthorAllowlist(raw)).toThrow("ALLOWED_AUTHORS entry must be a GitHub login");
  });
});

describe("isAuthorAllowed", () => {
  it("allowlist が空なら、誰も許可されない", () => {
    expect(isAuthorAllowed([], "alice")).toBe(false);
  });

  it.each([
    { login: "alice", expected: true },
    { login: "ALICE", expected: true },
    { login: "alice[bot]", expected: true },
    { login: "bob", expected: false },
    { login: "alice2", expected: false },
    { login: "", expected: false },
  ])("alice のみ許可: $login → $expected", ({ login, expected }) => {
    expect(isAuthorAllowed(["alice"], login)).toBe(expected);
  });
});

describe("evaluatePullRequestOrigin", () => {
  const ALLOWED = ["alice"];

  it.each([
    // allowlist が空（未設定）なら、作成者や fork の状態にかかわらず拒否する（fail-closed）。
    {
      name: "allowlist が空なら、許可されそうな PR でも拒否",
      allowed: [],
      authorLogin: "alice",
      fork: false,
      expected: { allowed: false, reason: "author_allowlist_empty" },
    },
    {
      name: "allowlist が空なら、作成者も head も取得できない場合も、空を理由に拒否",
      allowed: [],
      authorLogin: null,
      fork: null,
      expected: { allowed: false, reason: "author_allowlist_empty" },
    },
    {
      name: "許可された作成者の同一 repository の PR",
      allowed: ALLOWED,
      authorLogin: "alice",
      fork: false,
      expected: { allowed: true },
    },
    {
      name: "bot 名義の表記違いも同じ作成者",
      allowed: ALLOWED,
      authorLogin: "Alice[bot]",
      fork: false,
      expected: { allowed: true },
    },
    {
      name: "作成者を取得できない",
      allowed: ALLOWED,
      authorLogin: null,
      fork: false,
      expected: { allowed: false, reason: "author_unknown" },
    },
    {
      name: "許可されていない作成者",
      allowed: ALLOWED,
      authorLogin: "mallory",
      fork: false,
      expected: { allowed: false, reason: "author_not_allowed" },
    },
    {
      name: "許可された作成者でも fork は拒否",
      allowed: ALLOWED,
      authorLogin: "alice",
      fork: true,
      expected: { allowed: false, reason: "fork" },
    },
    {
      name: "head の repository を取得できない",
      allowed: ALLOWED,
      authorLogin: "alice",
      fork: null,
      expected: { allowed: false, reason: "head_repo_unknown" },
    },
    // 判定の順序: 作成者の拒否が fork より先
    {
      name: "許可されていない作成者の fork は、作成者を理由に拒否",
      allowed: ALLOWED,
      authorLogin: "mallory",
      fork: true,
      expected: { allowed: false, reason: "author_not_allowed" },
    },
  ])("$name", ({ allowed, authorLogin, fork, expected }) => {
    expect(evaluatePullRequestOrigin(allowed, { authorLogin, fork })).toEqual(expected);
  });
});

describe("PullRequestOriginNotAllowedError", () => {
  it("対象と理由を持ち、メッセージに作成者の login を含めない", () => {
    const error = new PullRequestOriginNotAllowedError("org", "repo", 7, "author_not_allowed");

    expect(error.name).toBe("PullRequestOriginNotAllowedError");
    expect(error.message).toBe("Pull request org/repo#7 is not allowed: author_not_allowed");
    expect(error).toMatchObject({
      owner: "org",
      repo: "repo",
      prNumber: 7,
      reason: "author_not_allowed",
    });
  });
});
