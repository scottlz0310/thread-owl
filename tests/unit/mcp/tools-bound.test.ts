import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GitHubClient } from "../../../src/github/client.js";
import type { WriteContext } from "../../../src/github/write-context.js";
import type { ToolDeps } from "../../../src/mcp/tool-deps.js";

vi.mock("../../../src/github/pull-requests.js");

import * as pullRequests from "../../../src/github/pull-requests.js";
import { runTool } from "../../../src/mcp/server.js";
import {
  approvePullRequestInputSchema,
  approvePullRequestTool,
} from "../../../src/mcp/tools/approve-pull-request.js";
import {
  postReviewVerdictInputSchema,
  postReviewVerdictTool,
} from "../../../src/mcp/tools/post-review-verdict.js";
import { postSummaryInputSchema, postSummaryTool } from "../../../src/mcp/tools/post-summary.js";
import { createReviewQueue } from "../../../src/queue/review-queue.js";
import { ContractError } from "../../../src/review-cycle/errors.js";
import { ReviewCycleLedger } from "../../../src/review-cycle/ledger.js";
import { ResultBinder } from "../../../src/review-cycle/result-binder.js";
import { createFakeGithub } from "../../../src/review-cycle/testing/fake-github.js";

const ctx = {
  client: {} as GitHubClient,
  allowedRepos: ["o/r"],
  logger: {},
} as unknown as WriteContext;
const HEAD = "3facb641b17b1f31e9fb1895b558548cd48dcb78";
const CANDIDATE = "cand_01jbq3x8n5r7t9v2w4y6z8a0d1";
const MARKER = "<!-- thread-owl:cycle test-marker -->";
const pr = { owner: "o", repo: "r", prNumber: 7 };

function makeDeps(binder?: Pick<ResultBinder, "post">): ToolDeps {
  return {
    getClient: vi.fn(),
    getWriteContext: vi.fn().mockResolvedValue(ctx),
    allowedRepos: ["o/r"],
    allowedAuthors: [],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    resolveInstallationId: vi.fn(),
    resultBinder: binder as ResultBinder | undefined,
  };
}

// 束縛の本体は ResultBinder のテストで検証している。ここでは tool が渡す引数と、書込みの中身だけを見る。
function stubBinder() {
  const post = vi.fn(async (request: Parameters<ResultBinder["post"]>[0]) => {
    // 実際の ResultBinder と同じく、書込みが返した投稿を結果の参照にする。
    const written = await request.write(MARKER);
    return {
      source: "thread-owl" as const,
      kind: request.kind,
      headSha: HEAD,
      resultVersion: 3,
      post: { commentId: written.id, url: written.url },
    };
  });
  return { post };
}

describe("candidateId 指定の投稿 tool", () => {
  it("post_summary_comment: 本文にマーカーを付けて投稿し、reviewed として束縛する", async () => {
    const binder = stubBinder();
    vi.mocked(pullRequests.postSummaryComment).mockResolvedValue(100);

    const result = await postSummaryTool(makeDeps(binder), {
      ...pr,
      body: "本文",
      headSha: HEAD,
      candidateId: CANDIDATE,
    });

    expect(pullRequests.postSummaryComment).toHaveBeenCalledWith(
      ctx,
      "o",
      "r",
      7,
      `本文\n\n${MARKER}`,
    );
    expect(binder.post).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: CANDIDATE,
        pr: expect.objectContaining(pr),
        headSha: HEAD,
        kind: "reviewed",
      }),
    );
    expect(result).toEqual({ ok: true, resultVersion: 3 });
    // 書込みが返す URL は、投稿した issue comment を指す
    const write = binder.post.mock.calls[0][0].write;
    await expect(write(MARKER)).resolves.toEqual({
      id: 100,
      url: "https://github.com/o/r/pull/7#issuecomment-100",
    });
  });

  it("post_review_verdict: マーカーを Verdict の書込みへ渡し、reviewed として束縛する", async () => {
    const binder = stubBinder();
    vi.mocked(pullRequests.postReviewVerdict).mockResolvedValue(200);

    const result = await postReviewVerdictTool(makeDeps(binder), {
      ...pr,
      headSha: HEAD,
      summary: "問題なし",
      candidateId: CANDIDATE,
    });

    expect(pullRequests.postReviewVerdict).toHaveBeenCalledWith(
      ctx,
      "o",
      "r",
      7,
      HEAD,
      "問題なし",
      MARKER,
    );
    expect(binder.post).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: CANDIDATE, headSha: HEAD, kind: "reviewed" }),
    );
    expect(result).toEqual({ ok: true, commentId: 200, resultVersion: 3 });
  });

  it.each([
    ["本文なし", undefined, MARKER],
    ["本文あり", "承認します", `承認します\n\n${MARKER}`],
  ])(
    "approve_pull_request: %s は本文にマーカーを付けて承認し、approved として束縛する",
    async (_name, body, expectedBody) => {
      const binder = stubBinder();
      vi.mocked(pullRequests.approvePR).mockResolvedValue(300);

      const result = await approvePullRequestTool(makeDeps(binder), {
        ...pr,
        expectedHeadSha: HEAD,
        body,
        candidateId: CANDIDATE,
      });

      expect(pullRequests.approvePR).toHaveBeenCalledWith(ctx, "o", "r", 7, HEAD, expectedBody);
      expect(binder.post).toHaveBeenCalledWith(
        expect.objectContaining({ candidateId: CANDIDATE, headSha: HEAD, kind: "approved" }),
      );
      expect(result).toEqual({ ok: true, resultVersion: 3 });
      const write = binder.post.mock.calls[0][0].write;
      await expect(write(MARKER)).resolves.toEqual({
        id: 300,
        url: "https://github.com/o/r/pull/7#pullrequestreview-300",
      });
    },
  );

  it("内部面が無効なら、candidateId を使う投稿は GitHub に書かずに拒否する", async () => {
    const deps = makeDeps(undefined);
    vi.mocked(pullRequests.postSummaryComment).mockClear();
    await expect(
      postSummaryTool(deps, { ...pr, body: "b", candidateId: CANDIDATE }),
    ).rejects.toThrow(/内部面/);
    await expect(
      postReviewVerdictTool(deps, { ...pr, headSha: HEAD, summary: "s", candidateId: CANDIDATE }),
    ).rejects.toThrow(/内部面/);
    await expect(
      approvePullRequestTool(deps, { ...pr, expectedHeadSha: HEAD, candidateId: CANDIDATE }),
    ).rejects.toThrow(/内部面/);
    expect(deps.getWriteContext).not.toHaveBeenCalled();
    expect(pullRequests.postSummaryComment).not.toHaveBeenCalled();
  });

  it("candidateId を指定しない投稿は、束縛を通さない（旧経路・後方互換）", async () => {
    const binder = stubBinder();
    vi.mocked(pullRequests.postSummaryComment).mockResolvedValue(100);
    const result = await postSummaryTool(makeDeps(binder), { ...pr, body: "b" });
    expect(binder.post).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("Verdict らしい本文の summary は、candidateId 指定でも WriteContext 取得前に拒否する", async () => {
    const binder = stubBinder();
    const deps = makeDeps(binder);
    await expect(
      postSummaryTool(deps, { ...pr, body: "## Verdict", candidateId: CANDIDATE }),
    ).rejects.toThrow(/post_review_verdict/);
    expect(binder.post).not.toHaveBeenCalled();
    expect(deps.getWriteContext).not.toHaveBeenCalled();
  });

  it.each([
    ["post_summary_comment", postSummaryInputSchema],
    ["post_review_verdict", postReviewVerdictInputSchema],
    ["approve_pull_request", approvePullRequestInputSchema],
  ])("%s の入力は、書式の合う candidateId だけを受け付ける", (_name, shape) => {
    const schema = z.object(shape);
    const base = {
      owner: "o",
      repo: "r",
      prNumber: 7,
      body: "b",
      headSha: HEAD,
      summary: "s",
      expectedHeadSha: HEAD,
    };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, candidateId: CANDIDATE }).success).toBe(true);
    expect(schema.safeParse({ ...base, candidateId: "cand_short" }).success).toBe(false);
  });
});

describe("post_review_verdict: 実際の ResultBinder を通る停止後の回復", () => {
  it("投稿成功後に停止した Verdict を回復したとき、応答の commentId は既存の投稿の ID", async () => {
    const ledger = new ReviewCycleLedger({ path: ":memory:" });
    try {
      const github = createFakeGithub();
      const binder = new ResultBinder({
        ledger,
        queue: createReviewQueue(),
        getClient: async () => github.client,
        botLogin: "thread-owl[bot]",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
      const { candidateId } = ledger.accept({
        cycleId: "cyc_01jbq3x8n5r7t9v2w4y6z8a0c1",
        round: 1,
        ...pr,
        headSha: HEAD,
        reason: "opened",
        sourceId: null,
        installationId: 1,
      });
      const deps = makeDeps(binder);

      // 1 回目: GitHub に投稿されたが、記録の前に失敗した（マーカーは GitHub 上に残る）
      let marker = "";
      vi.mocked(pullRequests.postReviewVerdict).mockImplementationOnce(
        async (_ctx, _o, _r, _n, _head, _summary, m) => {
          marker = m ?? "";
          throw new Error("crashed after post");
        },
      );
      await expect(
        postReviewVerdictTool(deps, { ...pr, headSha: HEAD, summary: "s", candidateId }),
      ).rejects.toThrow("crashed after post");
      github.posts.push({
        kind: "comment",
        id: 9200,
        body: marker,
        login: "thread-owl[bot]",
        createdAt: "2026-10-25T00:00:00Z",
      });

      // 2 回目: 再投稿せず、既存の投稿 ID を返す
      vi.mocked(pullRequests.postReviewVerdict).mockClear();
      const result = await postReviewVerdictTool(deps, {
        ...pr,
        headSha: HEAD,
        summary: "s",
        candidateId,
      });
      expect(pullRequests.postReviewVerdict).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true, commentId: 9200 });
    } finally {
      ledger.close();
    }
  });
});

describe("runTool", () => {
  it("契約のエラーは code を付けて返す（reviewer が取消・HEAD 不一致を区別できる）", async () => {
    const result = await runTool(async () => {
      throw new ContractError("CANDIDATE_CANCELLED", "取消済みの候補は投稿しない");
    });
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "CANDIDATE_CANCELLED: 取消済みの候補は投稿しない" }],
    });
  });
});
