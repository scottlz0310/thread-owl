import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  addReviewThreadReply,
  getReviewThread,
  getThreadRepository,
  listReviewThreads,
} from "../../../src/github/graphql.js";

function makeClient(graphql: unknown): GitHubClient {
  return { graphql } as unknown as GitHubClient;
}

function commentNode(index: number) {
  return {
    id: `C_${index}`,
    body: `comment ${index}`,
    author: { login: "reviewer" },
    createdAt: "2026-01-01T00:00:00Z",
    url: `https://github.com/o/r/pull/7#discussion_r${index}`,
  };
}

function threadNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 10,
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [commentNode(1)],
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
          body: "comment 1",
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
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "C_1", body: "x", author: null, createdAt: "t", url: "u" }],
            },
          }),
        ],
        { hasNextPage: false, endCursor: null },
      ),
    );

    const threads = await listReviewThreads(makeClient(graphql), "o", "r", 7);

    expect(threads[0].comments[0].author).toBe("");
  });
});

const threadReadCases = [
  {
    name: "listReviewThreads",
    initialResponse: (node: ReturnType<typeof threadNode>) =>
      page([node], { hasNextPage: false, endCursor: null }),
    read: async (client: GitHubClient) => (await listReviewThreads(client, "o", "r", 7))[0],
  },
  {
    name: "getReviewThread",
    initialResponse: (node: ReturnType<typeof threadNode>) => ({ node }),
    read: (client: GitHubClient) => getReviewThread(client, "PRRT_1"),
  },
];

describe.each(threadReadCases)("$name comment pagination", ({ initialResponse, read }) => {
  it("100 件以下では追加 GraphQL 呼び出しを行わない", async () => {
    const comments = Array.from({ length: 100 }, (_, index) => commentNode(index + 1));
    const graphql = vi.fn().mockResolvedValue(
      initialResponse(
        threadNode({
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: comments,
          },
        }),
      ),
    );

    const thread = await read(makeClient(graphql));

    expect(thread?.comments).toHaveLength(100);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(graphql.mock.calls[0][0]).toContain("comments(first: 100)");
    expect(graphql.mock.calls[0][0]).toContain("pageInfo");
  });

  it("101 件以上のコメントを cursor で順次取得する", async () => {
    const initialComments = Array.from({ length: 100 }, (_, index) => commentNode(index + 1));
    const secondPageComments = Array.from({ length: 100 }, (_, index) => commentNode(index + 101));
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(
        initialResponse(
          threadNode({
            comments: {
              pageInfo: { hasNextPage: true, endCursor: "COMMENT_CURSOR_100" },
              nodes: initialComments,
            },
          }),
        ),
      )
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: { hasNextPage: true, endCursor: "COMMENT_CURSOR_200" },
            nodes: secondPageComments,
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [commentNode(201)],
          },
        },
      });

    const thread = await read(makeClient(graphql));

    expect(thread?.comments).toHaveLength(201);
    expect(thread?.comments.at(-1)?.id).toBe("C_201");
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(graphql.mock.calls[1][0]).toContain("comments(first: 100, after: $cursor)");
    expect(graphql.mock.calls[1][1]).toEqual({
      threadId: "PRRT_1",
      cursor: "COMMENT_CURSOR_100",
    });
    expect(graphql.mock.calls[2][1]).toEqual({
      threadId: "PRRT_1",
      cursor: "COMMENT_CURSOR_200",
    });
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

describe("getThreadRepository", () => {
  it("threadId から所属リポジトリ（owner/repo）を取得する", async () => {
    const graphql = vi.fn().mockResolvedValue({
      node: { repository: { name: "repo", owner: { login: "owner" } } },
    });

    const result = await getThreadRepository(makeClient(graphql), "PRRT_1");

    expect(result).toEqual({ owner: "owner", repo: "repo" });
    expect(graphql.mock.calls[0][1]).toEqual({ threadId: "PRRT_1" });
  });

  it("node が存在しない場合は null を返す", async () => {
    const graphql = vi.fn().mockResolvedValue({ node: null });

    expect(await getThreadRepository(makeClient(graphql), "missing")).toBeNull();
  });
});
