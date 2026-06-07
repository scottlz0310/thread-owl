import { describe, expect, test, vi } from "vitest";
import type { Logger } from "../../config/logging.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { handleIssueCommentEvent } from "./issue-comment.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const ALLOWED = ["org/repo"];

function makeEvent(
  overrides: Partial<NormalizedEvent> & { action?: string; hasPr?: boolean },
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
    },
    ...rest,
  };
}

test("PR 付き issue_comment created → info ログ", async () => {
  const logger = makeLogger();
  await handleIssueCommentEvent(makeEvent({}), { logger, allowedRepos: ALLOWED });
  expect(logger.info).toHaveBeenCalledWith(
    "webhook.issue_comment.received",
    expect.objectContaining({ owner: "org", repo: "repo", prNumber: 7 }),
  );
});

test("PR のない issue comment は無視する", async () => {
  const logger = makeLogger();
  await handleIssueCommentEvent(makeEvent({ hasPr: false }), { logger, allowedRepos: ALLOWED });
  expect(logger.info).not.toHaveBeenCalled();
});

test("created 以外の action は無視する", async () => {
  const logger = makeLogger();
  await handleIssueCommentEvent(makeEvent({ action: "edited" }), { logger, allowedRepos: ALLOWED });
  expect(logger.info).not.toHaveBeenCalled();
});

test("allowlist 外は無視する", async () => {
  const logger = makeLogger();
  await handleIssueCommentEvent(makeEvent({ owner: "evil", repo: "hax" }), {
    logger,
    allowedRepos: ALLOWED,
  });
  expect(logger.info).not.toHaveBeenCalled();
  expect(logger.debug).toHaveBeenCalledWith(
    "webhook.issue_comment.allowlist.rejected",
    expect.objectContaining({ owner: "evil", repo: "hax" }),
  );
});

test("payload が record でない場合は何もしない", async () => {
  const logger = makeLogger();
  const event: NormalizedEvent = {
    type: "issue_comment",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    payload: null,
  };
  await handleIssueCommentEvent(event, { logger, allowedRepos: ALLOWED });
  expect(logger.info).not.toHaveBeenCalled();
});

describe("issue フィールドの異常系", () => {
  test("issue が record でない場合は何もしない", async () => {
    const logger = makeLogger();
    const event: NormalizedEvent = {
      type: "issue_comment",
      deliveryId: "d-1",
      installationId: 1,
      owner: "org",
      repo: "repo",
      payload: { action: "created", issue: null },
    };
    await handleIssueCommentEvent(event, { logger, allowedRepos: ALLOWED });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
