import { describe, expect, it } from "vitest";
import {
  RepositoryNotAllowedError,
  assertRepoWritable,
  isAllowed,
  parseAllowlist,
} from "../../../src/policy/allowlist.js";

describe("isAllowed", () => {
  const allowlist = ["octo-org/octo-repo", "acme/widgets"];

  it.each([
    { owner: "octo-org", repo: "octo-repo", expected: true },
    { owner: "Octo-Org", repo: "Octo-Repo", expected: true }, // case-insensitive
    { owner: "acme", repo: "widgets", expected: true },
    { owner: "octo-org", repo: "other-repo", expected: false },
    { owner: "evil", repo: "repo", expected: false },
  ])("$owner/$repo → $expected", ({ owner, repo, expected }) => {
    expect(isAllowed(allowlist, owner, repo)).toBe(expected);
  });

  it("allowedRepos が空なら全拒否（fail-closed）", () => {
    expect(isAllowed([], "octo-org", "octo-repo")).toBe(false);
  });

  describe("owner/* ワイルドカード", () => {
    const wildcardList = ["octo-org/*", "acme/widgets"];

    it.each([
      { owner: "octo-org", repo: "any-repo", expected: true },
      { owner: "octo-org", repo: "another", expected: true },
      { owner: "Octo-Org", repo: "Repo", expected: true }, // case-insensitive
      { owner: "acme", repo: "widgets", expected: true }, // 完全一致も有効
      { owner: "acme", repo: "other", expected: false }, // acme/* がないので拒否
      { owner: "evil", repo: "repo", expected: false },
    ])("$owner/$repo → $expected", ({ owner, repo, expected }) => {
      expect(isAllowed(wildcardList, owner, repo)).toBe(expected);
    });
  });
});

describe("parseAllowlist", () => {
  it.each([
    { raw: "owner/repo", expected: ["owner/repo"] },
    { raw: " owner/repo ", expected: ["owner/repo"] }, // トリム
    { raw: "Owner/Repo", expected: ["owner/repo"] }, // 小文字化
    { raw: "owner/repo,owner/repo", expected: ["owner/repo"] }, // 重複除去
    { raw: "Owner/Repo,owner/repo", expected: ["owner/repo"] }, // 小文字化後の重複除去
    { raw: "a/b,c/d", expected: ["a/b", "c/d"] },
    { raw: "owner/*", expected: ["owner/*"] }, // ワイルドカード
    { raw: "Owner/*", expected: ["owner/*"] }, // ワイルドカード小文字化
    { raw: "a/*,b/repo", expected: ["a/*", "b/repo"] }, // 混在
    { raw: "", expected: [] },
    { raw: ",", expected: [] },
    { raw: " , ", expected: [] },
  ])("'$raw' を正規化する → $expected", ({ raw, expected }) => {
    expect(parseAllowlist(raw).repos).toEqual(expected);
  });

  it.each([
    { raw: "owner/" },
    { raw: "/repo" },
    { raw: "owner/repo/extra" },
    { raw: "noslash" },
    { raw: "owner/repo,bad-entry" },
    { raw: "*/repo" }, // owner ワイルドカードは禁止
    { raw: "*/*" }, // 全許可は禁止
    { raw: "*" }, // 全許可は禁止
  ])("形式不正 '$raw' は throw する", ({ raw }) => {
    expect(() => parseAllowlist(raw)).toThrow("format");
  });
});

describe("assertRepoWritable", () => {
  it("allowlist 内なら何もしない", () => {
    expect(() => assertRepoWritable(["octo-org/octo-repo"], "octo-org", "octo-repo")).not.toThrow();
  });

  it("大文字小文字を無視して許可する", () => {
    expect(() => assertRepoWritable(["octo-org/octo-repo"], "Octo-Org", "Octo-Repo")).not.toThrow();
  });

  it("allowlist 外なら RepositoryNotAllowedError を throw する", () => {
    expect(() => assertRepoWritable(["octo-org/octo-repo"], "evil", "repo")).toThrow(
      RepositoryNotAllowedError,
    );
  });

  it("allowlist が空なら throw する（fail-closed）", () => {
    expect(() => assertRepoWritable([], "octo-org", "octo-repo")).toThrow(
      RepositoryNotAllowedError,
    );
  });
});
