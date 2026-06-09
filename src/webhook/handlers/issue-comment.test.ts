import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../../config/logging.js";
import type { ReviewQueue } from "../../queue/review-queue.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { handleIssueCommentEvent, type IssueCommentHandlerDeps } from "./issue-comment.js";

function makeQueue(): ReviewQueue {
  return {
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    list: vi.fn(() => []),
    size: vi.fn(() => 0),
    onEnqueue: vi.fn(() => () => {}),
    onReReviewRequested: vi.fn(() => () => {}),
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function makeDeps(overrides: Partial<IssueCommentHandlerDeps> = {}): IssueCommentHandlerDeps {
  return {
    queue: makeQueue(),
    logger: makeLogger(),
    allowedRepos: ["org/repo"],
    appSlug: "thread-owl",
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<NormalizedEvent> & { action?: string; hasPr?: boolean } = {},
): NormalizedEvent {
  const { action = "created", hasPr = true, ...rest } = overrides;
  return {
    type: "issue_comment",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: {
      action,
      issue: {
        number: 7,
        pull_request: hasPr ? { url: "https://api.github.com/repos/org/repo/pulls/7" } : undefined,
      },
      comment: {
        id: 1,
        body: "@thread-owl re-review requested",
        user: { login: "human-user" },
      },
    },
    ...rest,
  };
}

test("@thread-owl re-review mention → enqueue して info ログ", async () => {
  const deps = makeDeps();
  await handleIssueCommentEvent(makeEvent(), deps);
  expect(deps.queue.enqueue).toHaveBeenCalledOnce();
  expect(deps.logger.info).toHaveBeenCalledWith(
    "webhook.issue_comment.re_review_queued",
    expect.objectContaining({ owner: "org", repo: "repo", prNumber: 7 }),
  );
});

test("re-review intent のない PR コメントは enqueue しない", async () => {
  const deps = makeDeps();
  const event = makeEvent();
  (event.payload as Record<string, unknown>).comment = {
    id: 2,
    body: "@thread-owl LGTM!",
    user: { login: "human-user" },
  };
  await handleIssueCommentEvent(event, deps);
  expect(deps.queue.enqueue).not.toHaveBeenCalled();
  expect(deps.logger.debug).toHaveBeenCalledWith(
    "webhook.issue_comment.no_rereview_intent",
    expect.anything(),
  );
});

test("PR のない issue comment は enqueue しない", async () => {
  const deps = makeDeps();
  await handleIssueCommentEvent(makeEvent({ hasPr: false }), deps);
  expect(deps.queue.enqueue).not.toHaveBeenCalled();
});

test("created 以外の action は enqueue しない", async () => {
  const deps = makeDeps();
  await handleIssueCommentEvent(makeEvent({ action: "edited" }), deps);
  expect(deps.queue.enqueue).not.toHaveBeenCalled();
});

test("allowlist 外は enqueue しない", async () => {
  const deps = makeDeps({ allowedRepos: [] });
  await handleIssueCommentEvent(makeEvent(), deps);
  expect(deps.queue.enqueue).not.toHaveBeenCalled();
  expect(deps.logger.debug).toHaveBeenCalledWith(
    "webhook.issue_comment.allowlist.rejected",
    expect.objectContaining({ owner: "org", repo: "repo" }),
  );
});

test("payload が record でない場合は何もしない", async () => {
  const deps = makeDeps();
  const event: NormalizedEvent = {
    type: "issue_comment",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    payload: null,
  };
  await handleIssueCommentEvent(event, deps);
  expect(deps.queue.enqueue).not.toHaveBeenCalled();
});

describe("issue フィールドの異常系", () => {
  test("issue が record でない場合は何もしない", async () => {
    const deps = makeDeps();
    const event: NormalizedEvent = {
      type: "issue_comment",
      deliveryId: "d-1",
      installationId: 1,
      owner: "org",
      repo: "repo",
      payload: { action: "created", issue: null },
    };
    await handleIssueCommentEvent(event, deps);
    expect(deps.queue.enqueue).not.toHaveBeenCalled();
  });
});
