import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  if (!signature.startsWith("sha256=")) return false;
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  const expected = Buffer.from(`sha256=${digest}`);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
