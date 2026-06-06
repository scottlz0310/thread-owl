import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../src/config/logging.js";
import type { GitHubClient } from "../../../src/github/client.js";
import {
  listOpenThreads,
  replyToThread,
  resolveThread,
} from "../../../src/github/review-threads.js";
import type { WriteContext } from "../../../src/github/write-context.js";
import { RepositoryNotAllowedError } from "../../../src/policy/allowlist.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

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

describe("replyToThread", () => {
  it("allowlist 内なら返信し監査ログを残す", async () => {
    const graphql = vi.fn().mockResolvedValue({
      addPullRequestReviewThreadReply: { comment: { id: "PRRC_1", url: "u" } },
    });
    const logger = makeLogger();
    const ctx: WriteContext = {
      client: { graphql } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger,
    };

    await replyToThread(ctx, "o", "r", "PRRT_1", "thanks");

    expect(graphql).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "review.thread_reply",
      expect.objectContaining({ threadId: "PRRT_1", commentId: "PRRC_1" }),
    );
  });

  it("allowlist 外なら throw し API を呼ばない", async () => {
    const graphql = vi.fn();
    const ctx: WriteContext = {
      client: { graphql } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };

    await expect(replyToThread(ctx, "evil", "repo", "PRRT_1", "x")).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe("resolveThread", () => {
  it("allowlist 内なら resolve し監査ログを残す", async () => {
    const graphql = vi.fn().mockResolvedValue({
      resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } },
    });
    const logger = makeLogger();
    const ctx: WriteContext = {
      client: { graphql } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger,
    };

    await resolveThread(ctx, "o", "r", "PRRT_1");

    expect(graphql).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "review.thread_resolve",
      expect.objectContaining({ threadId: "PRRT_1" }),
    );
  });

  it("allowlist 外なら throw し API を呼ばない", async () => {
    const graphql = vi.fn();
    const ctx: WriteContext = {
      client: { graphql } as unknown as GitHubClient,
      allowedRepos: ["o/r"],
      logger: makeLogger(),
    };

    await expect(resolveThread(ctx, "evil", "repo", "PRRT_1")).rejects.toThrow(
      RepositoryNotAllowedError,
    );
    expect(graphql).not.toHaveBeenCalled();
  });
});
