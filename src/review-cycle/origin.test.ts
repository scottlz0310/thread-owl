import { describe, expect, test, vi } from "vitest";
import type { GitHubClient } from "../github/client.js";
import type { getPR } from "../github/pull-requests.js";
import { createOriginChecker } from "./origin.js";

type Fetcher = typeof getPR;

function prWith(author: string | null, fork: boolean | null): Awaited<ReturnType<Fetcher>> {
  return {
    author: author === null ? null : { login: author, type: "User" },
    head: { repo: fork === null ? null : { fullName: "x/y", fork } },
  } as unknown as Awaited<ReturnType<Fetcher>>;
}

interface Options {
  allowedRepos?: string[];
  allowedAuthors?: string[];
  pr?: Awaited<ReturnType<Fetcher>>;
  fetchError?: Error;
}

function setup(options: Options) {
  const fetchPr = vi.fn<Fetcher>(async () => {
    if (options.fetchError) throw options.fetchError;
    return options.pr ?? prWith("alice", false);
  });
  const warn = vi.fn();
  const check = createOriginChecker(
    {
      getClient: async () => ({}) as GitHubClient,
      allowedRepos: options.allowedRepos ?? ["org/*"],
      allowedAuthors: options.allowedAuthors ?? ["alice"],
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    },
    fetchPr,
  );
  return { check, fetchPr, warn };
}

describe("createOriginChecker", () => {
  test("許可された repo・作成者の同一 repo の PR は受け付ける", async () => {
    const { check, fetchPr } = setup({});
    await expect(check("org", "repo", 1)).resolves.toEqual({ allowed: true });
    expect(fetchPr).toHaveBeenCalledOnce();
  });

  test.each<[string, Options, string, boolean]>([
    ["repo が allowlist 外", { allowedRepos: ["other/*"] }, "repository_not_allowed", false],
    ["作成者の allowlist が空", { allowedAuthors: [] }, "author_allowlist_empty", false],
    ["作成者が不明", { pr: prWith(null, false) }, "author_unknown", true],
    ["作成者が許可外", { pr: prWith("mallory", false) }, "author_not_allowed", true],
    ["head の repository が不明", { pr: prWith("alice", null) }, "head_repo_unknown", true],
    ["fork（作成者が許可されていても）", { pr: prWith("alice", true) }, "fork", true],
  ])("%s は拒否する", async (_name, options, reason, fetched) => {
    const { check, fetchPr, warn } = setup(options);
    await expect(check("org", "repo", 1)).resolves.toEqual({ allowed: false, reason });
    expect(fetchPr).toHaveBeenCalledTimes(fetched ? 1 : 0);
    // repo の allowlist 外は判定前の拒否なので、origin の監査ログは対象外
    expect(warn).toHaveBeenCalledTimes(reason === "repository_not_allowed" ? 0 : 1);
  });

  test("PR を取得できないときは例外のまま伝播する（fail-closed）", async () => {
    const { check } = setup({ fetchError: new Error("network") });
    await expect(check("org", "repo", 1)).rejects.toThrow("network");
  });
});
