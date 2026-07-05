import { describe, expect, test, vi } from "vitest";
import { RepositoryNotAllowedError } from "../../policy/allowlist.js";
import { createReviewQueue } from "../../queue/review-queue.js";
import { type EnqueueReviewToolDeps, enqueueReviewTool } from "./enqueue-review.js";

function makeDeps(overrides: Partial<EnqueueReviewToolDeps> = {}): EnqueueReviewToolDeps {
  return {
    getClient: async (): Promise<never> => {
      throw new Error("not used");
    },
    getWriteContext: async (): Promise<never> => {
      throw new Error("not used");
    },
    allowedRepos: ["org/repo"],
    resolveInstallationId: async (): Promise<number> => 123,
    queue: createReviewQueue(),
    ...overrides,
  };
}

describe("enqueueReviewTool", () => {
  test("enqueues a candidate and returns ok", async () => {
    const deps = makeDeps();

    const result = await enqueueReviewTool(deps, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      reason: "opened",
    });

    expect(result).toEqual({ ok: true });
    const items = deps.queue.list();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      owner: "org",
      repo: "repo",
      prNumber: 1,
      reason: "opened",
      installationId: 123,
    });
    expect(items[0].requestedBy).toBeUndefined();
  });

  test("passes requestedBy through for re-review-requested", async () => {
    const deps = makeDeps();

    await enqueueReviewTool(deps, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      reason: "re-review-requested",
      requestedBy: "alice",
    });

    expect(deps.queue.list()[0].requestedBy).toBe("alice");
  });

  test("rejects repos outside allowlist and does not enqueue", async () => {
    const deps = makeDeps({ allowedRepos: ["other/repo"] });

    await expect(
      enqueueReviewTool(deps, { owner: "org", repo: "repo", prNumber: 1, reason: "opened" }),
    ).rejects.toThrow(RepositoryNotAllowedError);
    expect(deps.queue.size()).toBe(0);
  });

  test("does not resolve installationId when repo is not allowed", async () => {
    const resolveInstallationId = vi.fn(async () => 999);
    const deps = makeDeps({ allowedRepos: ["other/repo"], resolveInstallationId });

    await expect(
      enqueueReviewTool(deps, { owner: "org", repo: "repo", prNumber: 1, reason: "opened" }),
    ).rejects.toThrow(RepositoryNotAllowedError);
    expect(resolveInstallationId).not.toHaveBeenCalled();
  });

  test("resolves installationId via deps.resolveInstallationId", async () => {
    const resolveInstallationId = vi.fn(async () => 999);
    const deps = makeDeps({ resolveInstallationId });

    await enqueueReviewTool(deps, { owner: "org", repo: "repo", prNumber: 1, reason: "opened" });

    expect(resolveInstallationId).toHaveBeenCalledWith("org", "repo");
    expect(deps.queue.list()[0].installationId).toBe(999);
  });

  test("triggers onEnqueue listener", async () => {
    const deps = makeDeps();
    let count = 0;
    deps.queue.onEnqueue(() => count++);

    await enqueueReviewTool(deps, { owner: "org", repo: "repo", prNumber: 1, reason: "opened" });

    expect(count).toBe(1);
  });

  test("ignores requestedBy when reason is not re-review-requested", async () => {
    const deps = makeDeps();

    await enqueueReviewTool(deps, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      reason: "opened",
      requestedBy: "alice",
    });

    expect(deps.queue.list()[0].requestedBy).toBeUndefined();
  });

  test("dedups same PR across owner/repo casing variants", async () => {
    const deps = makeDeps({ allowedRepos: ["org/repo"] });

    await enqueueReviewTool(deps, { owner: "org", repo: "repo", prNumber: 1, reason: "opened" });
    await enqueueReviewTool(deps, {
      owner: "ORG",
      repo: "REPO",
      prNumber: 1,
      reason: "synchronized",
    });

    expect(deps.queue.size()).toBe(1);
  });

  test("triggers onReReviewRequested listener only for re-review-requested", async () => {
    const deps = makeDeps();
    let count = 0;
    deps.queue.onReReviewRequested(() => count++);

    await enqueueReviewTool(deps, { owner: "org", repo: "repo", prNumber: 1, reason: "opened" });
    expect(count).toBe(0);

    await enqueueReviewTool(deps, {
      owner: "org",
      repo: "repo",
      prNumber: 1,
      reason: "re-review-requested",
    });
    expect(count).toBe(1);
  });
});
