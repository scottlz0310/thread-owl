import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../../config/logging.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { handlePullRequestEvent } from "./pull-request.js";

function makeQueue(): ReviewQueue {
  return {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    size: vi.fn().mockReturnValue(0),
    onEnqueue: vi.fn().mockReturnValue(() => undefined),
    onReReviewRequested: vi.fn().mockReturnValue(() => undefined),
    listenerCounts: vi.fn().mockReturnValue({ onEnqueue: 0, onReReviewRequested: 0 }),
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeEvent(
  overrides: Partial<NormalizedEvent> & { action?: string; draft?: boolean },
): NormalizedEvent {
  const { action = "opened", draft = false, ...rest } = overrides;
  return {
    type: "pull_request",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: {
      action,
      installation: { id: 1 },
      repository: { name: "repo", owner: { login: "org" } },
      pull_request: { number: 7, draft },
    },
    ...rest,
  };
}

const ALLOWED = ["org/repo"];

describe.each([
  { action: "opened", reason: "opened" },
  { action: "synchronize", reason: "synchronized" },
  { action: "ready_for_review", reason: "opened" },
] as const)("action=$action", ({ action, reason }) => {
  test("allowlist 内なら enqueue してログを出す", async () => {
    const queue = makeQueue();
    const logger = makeLogger();
    await handlePullRequestEvent(makeEvent({ action }), { queue, logger, allowedRepos: ALLOWED });

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "repo",
        prNumber: 7,
        installationId: 1,
        reason,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "webhook.pull_request.queued",
      expect.objectContaining({ action, reason }),
    );
  });
});

test("無関係な action は無視する", async () => {
  const queue = makeQueue();
  await handlePullRequestEvent(makeEvent({ action: "closed" }), {
    queue,
    logger: makeLogger(),
    allowedRepos: ALLOWED,
  });
  expect(queue.enqueue).not.toHaveBeenCalled();
});

test("draft PR (opened) はスキップする", async () => {
  const queue = makeQueue();
  const logger = makeLogger();
  await handlePullRequestEvent(makeEvent({ action: "opened", draft: true }), {
    queue,
    logger,
    allowedRepos: ALLOWED,
  });
  expect(queue.enqueue).not.toHaveBeenCalled();
  expect(logger.debug).toHaveBeenCalledWith(
    "webhook.pull_request.draft.skipped",
    expect.objectContaining({ owner: "org", repo: "repo" }),
  );
});

test("draft PR でも ready_for_review は enqueue する", async () => {
  const queue = makeQueue();
  await handlePullRequestEvent(makeEvent({ action: "ready_for_review", draft: true }), {
    queue,
    logger: makeLogger(),
    allowedRepos: ALLOWED,
  });
  expect(queue.enqueue).toHaveBeenCalled();
});

test("allowlist 外のリポジトリは無視する", async () => {
  const queue = makeQueue();
  const logger = makeLogger();
  await handlePullRequestEvent(makeEvent({ owner: "evil", repo: "hax" }), {
    queue,
    logger,
    allowedRepos: ALLOWED,
  });
  expect(queue.enqueue).not.toHaveBeenCalled();
  expect(logger.debug).toHaveBeenCalledWith(
    "webhook.pull_request.allowlist.rejected",
    expect.objectContaining({ owner: "evil", repo: "hax" }),
  );
});

test("payload が record でない場合は何もしない", async () => {
  const queue = makeQueue();
  const event: NormalizedEvent = {
    type: "pull_request",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: null,
  };
  await handlePullRequestEvent(event, { queue, logger: makeLogger(), allowedRepos: ALLOWED });
  expect(queue.enqueue).not.toHaveBeenCalled();
});

test("pull_request フィールドが record でない場合は何もしない", async () => {
  const queue = makeQueue();
  const event: NormalizedEvent = {
    type: "pull_request",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: { action: "opened", pull_request: null },
  };
  await handlePullRequestEvent(event, { queue, logger: makeLogger(), allowedRepos: ALLOWED });
  expect(queue.enqueue).not.toHaveBeenCalled();
});

test("prNumber が undefined の場合は何もしない", async () => {
  const queue = makeQueue();
  const event: NormalizedEvent = {
    type: "pull_request",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    prNumber: undefined,
    payload: { action: "opened", pull_request: { number: 7, draft: false } },
  };
  await handlePullRequestEvent(event, { queue, logger: makeLogger(), allowedRepos: ALLOWED });
  expect(queue.enqueue).not.toHaveBeenCalled();
});

test("同一 PR を再 enqueue しても重複エントリを作らない", async () => {
  const { createReviewQueue } = await import("../../queue/review-queue.js");
  const queue = createReviewQueue();
  const deps = { queue, logger: makeLogger(), allowedRepos: ALLOWED };

  await handlePullRequestEvent(makeEvent({ action: "opened" }), deps);
  await handlePullRequestEvent(makeEvent({ action: "synchronize" }), deps);

  expect(queue.size()).toBe(1);
  expect(queue.list()[0].reason).toBe("synchronized");
});
