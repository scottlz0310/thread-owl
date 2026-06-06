import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import { getPR, getPRFiles } from "../../../src/github/pull-requests.js";

describe("getPR / getPRFiles (high-level)", () => {
  it("getPR は PR 基本情報を返す", async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        number: 1,
        title: "t",
        body: null,
        state: "open",
        draft: false,
        head: { sha: "h", ref: "f" },
        base: { sha: "b", ref: "main" },
        html_url: "u",
      },
    });
    const client = { rest: { pulls: { get } } } as unknown as GitHubClient;

    const pr = await getPR(client, "o", "r", 1);

    expect(pr.number).toBe(1);
    expect(pr.head.sha).toBe("h");
  });

  it("getPRFiles は変更ファイル一覧を返す", async () => {
    const paginate = vi
      .fn()
      .mockResolvedValue([
        { filename: "a.ts", status: "modified", additions: 1, deletions: 2, patch: undefined },
      ]);
    const client = {
      rest: { pulls: { listFiles: vi.fn() }, paginate },
    } as unknown as GitHubClient;

    const files = await getPRFiles(client, "o", "r", 1);

    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("a.ts");
  });
});
