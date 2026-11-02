import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { GitHubClient } from "../../github/client.js";
import { getPR, getPRFiles } from "../../github/pull-requests.js";
import { createReviewStatusStore } from "../../queue/review-status.js";
import type { ToolDeps } from "../tool-deps.js";
import { getPrInputSchema, getPrTool } from "./get-pr.js";

vi.mock("../../github/pull-requests.js");

beforeEach(() => {
  vi.clearAllMocks();
});

function makePR(authorLogin: string) {
  return {
    number: 1,
    title: "t",
    body: null as string | null,
    state: "open",
    draft: false,
    author: { login: authorLogin, type: "User" },
    head: { sha: "headsha", ref: "feature", repo: { fullName: "org/repo", fork: false } },
    base: { sha: "basesha", ref: "main" },
    htmlUrl: "https://github.com/org/repo/pull/1",
  };
}

// 大きな応答を模す。クライアントが中間を省略するのは、files[].patch が大きいときである。
const largeFiles = Array.from({ length: 3 }, (_, i) => ({
  filename: `docs/file-${i}.md`,
  status: "modified",
  additions: 1000,
  deletions: 0,
  patch: "x".repeat(50_000),
}));

function makeDeps(allowedAuthors: readonly string[]): ToolDeps {
  return {
    getClient: async () => ({}) as unknown as GitHubClient,
    allowedAuthors,
  } as unknown as ToolDeps;
}

const input = { owner: "org", repo: "repo", prNumber: 1 };

describe("getPrTool", () => {
  test.each([undefined, true])(
    "includePatch=%sでは既存の応答とpatchを保持する",
    async (includePatch) => {
      vi.mocked(getPR).mockResolvedValue(makePR("alice"));
      vi.mocked(getPRFiles).mockResolvedValue(largeFiles);
      const result = await getPrTool(makeDeps(["alice"]), { ...input, includePatch });
      expect(Object.keys(result)).toEqual(["pr", "origin", "reviewAttempt", "files"]);
      expect(result.files).toEqual(largeFiles);
    },
  );

  test("patchを省略してもmetadataと開始時attemptを保持し、元のファイルを変更しない", async () => {
    const reviewStatus = createReviewStatusStore();
    reviewStatus.markPending(input, "headsha");
    const files = [...largeFiles, { ...largeFiles[0], filename: "binary.png", patch: undefined }];
    vi.mocked(getPR).mockResolvedValue(makePR("alice"));
    vi.mocked(getPRFiles).mockResolvedValue(files);
    const result = await getPrTool(
      { ...makeDeps(["alice"]), reviewStatus },
      { ...input, includePatch: false },
    );
    expect(Object.keys(result)).toEqual([
      "pr",
      "origin",
      "reviewAttempt",
      "patchesOmitted",
      "files",
    ]);
    expect(result.patchesOmitted).toBe(true);
    expect(result.pr).toEqual(makePR("alice"));
    expect(result.origin).toEqual({ allowed: true });
    expect(result.reviewAttempt).toEqual({
      attemptId: reviewStatus.get(input)?.attemptId,
      headSha: "headsha",
      status: "pending",
    });
    expect(result.files).toEqual(
      files.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
    );
    expect(result.files.every((file) => !Object.hasOwn(file, "patch"))).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(2_048);
    expect(files[0]?.patch).toHaveLength(50_000);
  });

  test("入力schemaは既定trueと明示falseを受理し、文字列を拒否する", () => {
    const schema = z.object(getPrInputSchema);
    expect(schema.parse(input).includePatch).toBe(true);
    expect(schema.parse({ ...input, includePatch: false }).includePatch).toBe(false);
    expect(schema.safeParse({ ...input, includePatch: "false" }).success).toBe(false);
  });

  test("開始時のattemptをfilesより前に公開し、read中の次enqueueに置換しない", async () => {
    const reviewStatus = createReviewStatusStore();
    reviewStatus.markPending(input, "headsha");
    const attemptId = reviewStatus.get(input)?.attemptId;
    vi.mocked(getPR).mockImplementationOnce(async () => {
      reviewStatus.markPending(input, "headsha");
      return makePR("alice");
    });
    vi.mocked(getPRFiles).mockResolvedValue([]);
    const result = await getPrTool({ ...makeDeps(["alice"]), reviewStatus }, input);
    expect(result.reviewAttempt).toEqual({ attemptId, headSha: "headsha", status: "pending" });
    expect(result.reviewAttempt?.attemptId).not.toBe(reviewStatus.get(input)?.attemptId);
  });
  test.each([
    { name: "許可された作成者", author: "alice", expected: { allowed: true } },
    {
      name: "許可されていない作成者",
      author: "mallory",
      expected: { allowed: false, reason: "author_not_allowed" },
    },
  ])("$name の origin を返す", async ({ author, expected }) => {
    vi.mocked(getPR).mockResolvedValue(makePR(author) as never);
    vi.mocked(getPRFiles).mockResolvedValue(largeFiles as never);

    const result = await getPrTool(makeDeps(["alice"]), input);

    expect(result.origin).toEqual(expected);
  });

  // origin が files の後ろにあると、大きな応答の中間が省略されたときに失われ、reviewer が止まる（thread-owl#291 の事例）。
  test("origin は files より前にシリアライズされる", async () => {
    vi.mocked(getPR).mockResolvedValue(makePR("alice") as never);
    vi.mocked(getPRFiles).mockResolvedValue(largeFiles as never);

    const result = await getPrTool(makeDeps(["alice"]), input);

    expect(Object.keys(result)).toEqual(["pr", "origin", "reviewAttempt", "files"]);
    const json = JSON.stringify(result);
    expect(json.indexOf('"origin"')).toBeLessThan(json.indexOf('"files"'));
    // 大きな files を含んでも、origin は応答の先頭側（先頭 2KB 以内）にある
    expect(json.length).toBeGreaterThan(100_000);
    expect(json.indexOf('"origin"')).toBeLessThan(2_048);
  });
});
