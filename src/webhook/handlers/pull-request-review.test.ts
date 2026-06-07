import { expect, test, vi } from "vitest";
import type { Logger } from "../../config/logging.js";
import type { NormalizedEvent } from "../normalize-event.js";
import { handlePullRequestReviewEvent } from "./pull-request-review.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const ALLOWED = ["org/repo"];

function makeEvent(overrides: Partial<NormalizedEvent> & { action?: string }): NormalizedEvent {
  const { action = "submitted", ...rest } = overrides;
  return {
    type: "pull_request_review",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    prNumber: 7,
    payload: { action, pull_request: { number: 7 } },
    ...rest,
  };
}

test("submitted → info ログ", async () => {
  const logger = makeLogger();
  await handlePullRequestReviewEvent(makeEvent({}), { logger, allowedRepos: ALLOWED });
  expect(logger.info).toHaveBeenCalledWith(
    "webhook.pull_request_review.received",
    expect.objectContaining({ owner: "org", repo: "repo", prNumber: 7 }),
  );
});

test("submitted 以外の action は無視する", async () => {
  const logger = makeLogger();
  await handlePullRequestReviewEvent(makeEvent({ action: "dismissed" }), {
    logger,
    allowedRepos: ALLOWED,
  });
  expect(logger.info).not.toHaveBeenCalled();
});

test("allowlist 外は無視する", async () => {
  const logger = makeLogger();
  await handlePullRequestReviewEvent(makeEvent({ owner: "evil", repo: "hax" }), {
    logger,
    allowedRepos: ALLOWED,
  });
  expect(logger.info).not.toHaveBeenCalled();
  expect(logger.debug).toHaveBeenCalledWith(
    "webhook.pull_request_review.allowlist.rejected",
    expect.objectContaining({ owner: "evil", repo: "hax" }),
  );
});

test("payload が record でない場合は何もしない", async () => {
  const logger = makeLogger();
  const event: NormalizedEvent = {
    type: "pull_request_review",
    deliveryId: "d-1",
    installationId: 1,
    owner: "org",
    repo: "repo",
    payload: null,
  };
  await handlePullRequestReviewEvent(event, { logger, allowedRepos: ALLOWED });
  expect(logger.info).not.toHaveBeenCalled();
});
