import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../src/config/logging.js";
import { auditWrite } from "../../../src/github/write-context.js";

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("auditWrite", () => {
  it("review.<action> イベントとして info ログに記録する", () => {
    const logger = makeLogger();

    auditWrite(logger, "summary_comment", {
      owner: "o",
      repo: "r",
      prNumber: 7,
      commentId: 1,
      bodyLength: 42,
    });

    expect(logger.info).toHaveBeenCalledWith("review.summary_comment", {
      event: "review.summary_comment",
      owner: "o",
      repo: "r",
      prNumber: 7,
      commentId: 1,
      bodyLength: 42,
    });
  });
});
