import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../config/logging.js";
import { RepositoryNotAllowedError } from "../policy/allowlist.js";
import { approvePR } from "./pull-requests.js";
import * as rest from "./rest.js";
import type { WriteContext } from "./write-context.js";

vi.mock("./rest.js");

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeCtx(overrides?: Partial<WriteContext>): WriteContext {
  return {
    client: {} as never,
    allowedRepos: ["org/repo"],
    logger: makeLogger(),
    ...overrides,
  };
}

function makePR(headSha: string) {
  return {
    number: 1,
    title: "test",
    body: null as string | null,
    state: "open",
    draft: false,
    head: { sha: headSha, ref: "feat/test" },
    base: { sha: "base-sha", ref: "main" },
    htmlUrl: "https://github.com/org/repo/pull/1",
  };
}

describe("approvePR", () => {
  test("allowlist 外リポジトリは RepositoryNotAllowedError を throw する", async () => {
    const ctx = makeCtx({ allowedRepos: [] });
    await expect(approvePR(ctx, "org", "repo", 1, "abc")).rejects.toThrow(
      RepositoryNotAllowedError,
    );
  });

  test("expectedHeadSha と実際の head が不一致の場合はエラーを throw する", async () => {
    vi.mocked(rest.getPullRequest).mockResolvedValueOnce(makePR("actual-sha"));

    const ctx = makeCtx();
    await expect(approvePR(ctx, "org", "repo", 1, "stale-sha")).rejects.toThrow(
      "Head SHA mismatch: expected stale-sha but PR #1 head is actual-sha",
    );
  });

  test("head SHA が一致する場合は approvePullRequest を呼び出して監査ログを記録する", async () => {
    const SHA = "abc123";
    vi.mocked(rest.getPullRequest).mockResolvedValueOnce(makePR(SHA));
    vi.mocked(rest.approvePullRequest).mockResolvedValueOnce(42);

    const logger = makeLogger();
    const ctx = makeCtx({ logger });
    await approvePR(ctx, "org", "repo", 1, SHA);

    expect(rest.approvePullRequest).toHaveBeenCalledWith(
      ctx.client,
      "org",
      "repo",
      1,
      SHA,
      undefined,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "review.approve",
      expect.objectContaining({ reviewId: 42, headSha: SHA }),
    );
  });

  test("body を渡すと approvePullRequest に転送される", async () => {
    const SHA = "def456";
    vi.mocked(rest.getPullRequest).mockResolvedValueOnce(makePR(SHA));
    vi.mocked(rest.approvePullRequest).mockResolvedValueOnce(99);

    const ctx = makeCtx();
    await approvePR(ctx, "org", "repo", 1, SHA, "LGTM");

    expect(rest.approvePullRequest).toHaveBeenCalledWith(ctx.client, "org", "repo", 1, SHA, "LGTM");
  });
});
