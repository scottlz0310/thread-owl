import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { verifyWebhookSignature } from "./verify-signature.js";

function makeSignature(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";
  const payload = '{"action":"opened"}';

  test("returns true for valid signature", () => {
    expect(verifyWebhookSignature(payload, makeSignature(payload, secret), secret)).toBe(true);
  });

  test.each([
    { label: "wrong secret", sig: makeSignature(payload, "wrong-secret") },
    { label: "wrong payload", sig: makeSignature("other-payload", secret) },
    {
      label: "missing sha256= prefix",
      sig: createHmac("sha256", secret).update(payload).digest("hex"),
    },
    { label: "empty signature", sig: "" },
    { label: "malformed signature", sig: "sha256=notahex!!!" },
  ])("returns false for $label", ({ sig }) => {
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(false);
  });
});
