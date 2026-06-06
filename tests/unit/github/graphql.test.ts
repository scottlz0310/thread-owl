import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  addReviewThreadReply,
  getReviewThread,
  listReviewThreads,
  resolveReviewThread,
} from "../../../src/github/graphql.js";

function makeClient(graphql: unknown): GitHubClient {
  return { graphql } as unknown as GitHubClient;
}

function threadNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 10,
    comments: {
      nodes: [
        {
          id: "C_1",
          body: "comment",
          author: { login: "reviewer" },
          createdAt: "2026-01-01T00:00:00Z",
          url: "https://github.com/o/r/pull/7#discussion_r1",
        },
      ],
    },
    ...overrides,
  };
}

function page(nodes: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }) {
  return { repository: { pullRequest: { reviewThreads: { pageInfo, nodes } } } };
}

describe("listReviewThreads", () => {
  it("resolved/outdated 状態とコメント・位置情報をマッピングする", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValue(
        page(
          [
            threadNode({ id: "PRRT_1", isResolved: false }),
            threadNode({ id: "PRRT_2", isResolved: true, isOutdated: true }),
          ],
          { hasNextPage: false, endCursor: null },
        ),
      );

    const threads = await listReviewThreads(makeClient(graphql), "o", "r", 7);

    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({
      id: "PRRT_1",
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 10,
      comments: [
        {
          id: "C_1",
          body: "comment",
          author: "reviewer",
          createdAt: "2026-01-01T00:00:00Z",
          url: "https://github.com/o/r/pull/7#discussion_r1",
        },
      ],
    });
    expect(threads[1].isResolved).toBe(true);
    expect(threads[1].isOutdated).toBe(true);
  });

  it("複数ページを cursor で取得する", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        page([threadNode({ id: "PRRT_1" })], { hasNextPage: true, endCursor: "CUR1" }),
      )
      .mockResolvedValueOnce(
        page([threadNode({ id: "PRRT_2" })], { hasNextPage: false, endCursor: null }),
      );

    const threads = await listReviewThreads(makeClient(graphql), "o", "r", 7);

    expect(threads.map((t) => t.id)).toEqual(["PRRT_1", "PRRT_2"]);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toMatchObject({ cursor: "CUR1" });
  });

  it("author が null のコメントは空文字に正規化する", async () => {
    const graphql = vi.fn().mockResolvedValue(
      page(
        [
          threadNode({
            comments: { nodes: [{ id: "C_1", body: "x", author: null, createdAt: "t", url: "u" }] },
          }),
        ],
        { hasNextPage: false, endCursor: null },
      ),
    );

    const threads = await listReviewThreads(makeClient(graphql), "o", "r", 7);

    expect(threads[0].comments[0].author).toBe("");
  });
});

describe("getReviewThread", () => {
  it("threadId から単体スレッドを取得する", async () => {
    const graphql = vi.fn().mockResolvedValue({ node: threadNode({ id: "PRRT_9" }) });

    const thread = await getReviewThread(makeClient(graphql), "PRRT_9");

    expect(thread?.id).toBe("PRRT_9");
    expect(graphql.mock.calls[0][1]).toEqual({ threadId: "PRRT_9" });
  });

  it("node が存在しない場合は null を返す", async () => {
    const graphql = vi.fn().mockResolvedValue({ node: null });

    expect(await getReviewThread(makeClient(graphql), "missing")).toBeNull();
  });
});

describe("addReviewThreadReply", () => {
  it("スレッドに返信し comment node id を返す", async () => {
    const graphql = vi.fn().mockResolvedValue({
      addPullRequestReviewThreadReply: { comment: { id: "PRRC_1", url: "https://example/c" } },
    });

    const id = await addReviewThreadReply(makeClient(graphql), "PRRT_1", "thanks");

    expect(id).toBe("PRRC_1");
    expect(graphql.mock.calls[0][1]).toEqual({ threadId: "PRRT_1", body: "thanks" });
  });
});

describe("resolveReviewThread", () => {
  it("スレッドを resolve する", async () => {
    const graphql = vi.fn().mockResolvedValue({
      resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
    });

    await resolveReviewThread(makeClient(graphql), "PRRT_1");

    expect(graphql.mock.calls[0][1]).toEqual({ threadId: "PRRT_1" });
  });
});
