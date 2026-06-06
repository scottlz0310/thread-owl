import { describe, expect, test } from "vitest";
import { normalizeEvent } from "./normalize-event.js";

const BASE_PAYLOAD = {
  installation: { id: 42 },
  repository: { name: "my-repo", owner: { login: "my-org" } },
};

const PR_PAYLOAD = { ...BASE_PAYLOAD, pull_request: { number: 7 } };
const ISSUE_PAYLOAD = { ...BASE_PAYLOAD, issue: { number: 7 } };

describe("normalizeEvent", () => {
  test.each([
    { eventType: "pull_request", payload: PR_PAYLOAD, expectedPrNumber: 7 },
    { eventType: "pull_request_review", payload: PR_PAYLOAD, expectedPrNumber: 7 },
    { eventType: "pull_request_review_comment", payload: PR_PAYLOAD, expectedPrNumber: 7 },
    { eventType: "issue_comment", payload: ISSUE_PAYLOAD, expectedPrNumber: 7 },
  ])("normalizes $eventType with correct fields", ({ eventType, payload, expectedPrNumber }) => {
    const result = normalizeEvent(eventType, "delivery-1", payload);
    expect(result.type).toBe(eventType);
    expect(result.deliveryId).toBe("delivery-1");
    expect(result.installationId).toBe(42);
    expect(result.owner).toBe("my-org");
    expect(result.repo).toBe("my-repo");
    expect(result.prNumber).toBe(expectedPrNumber);
  });

  test.each([
    { label: "unsupported event type", eventType: "push", payload: BASE_PAYLOAD },
    { label: "non-object payload", eventType: "pull_request", payload: "string" },
    {
      label: "missing installation",
      eventType: "pull_request",
      payload: { ...PR_PAYLOAD, installation: undefined },
    },
    {
      label: "missing repository",
      eventType: "pull_request",
      payload: { ...PR_PAYLOAD, repository: undefined },
    },
    {
      label: "missing pull_request.number",
      eventType: "pull_request",
      payload: { ...BASE_PAYLOAD, pull_request: {} },
    },
  ])("throws for $label", ({ eventType, payload }) => {
    expect(() => normalizeEvent(eventType, "d", payload)).toThrow();
  });

  test("issue_comment without issue field returns undefined prNumber", () => {
    const payload = { ...BASE_PAYLOAD };
    const result = normalizeEvent("issue_comment", "d", payload);
    expect(result.prNumber).toBeUndefined();
  });
});
