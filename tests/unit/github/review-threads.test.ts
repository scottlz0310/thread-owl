import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "../../../src/github/client.js";
import { listOpenThreads } from "../../../src/github/review-threads.js";

describe("listOpenThreads", () => {
  it("unresolved スレッドのみを返す", async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "T1",
                isResolved: false,
                isOutdated: false,
                path: "a",
                line: 1,
                comments: { nodes: [] },
              },
              {
                id: "T2",
                isResolved: true,
                isOutdated: false,
                path: "b",
                line: 2,
                comments: { nodes: [] },
              },
            ],
          },
        },
      },
    });
    const client = { graphql } as unknown as GitHubClient;

    const open = await listOpenThreads(client, "o", "r", 7);

    expect(open.map((t) => t.id)).toEqual(["T1"]);
  });
});
