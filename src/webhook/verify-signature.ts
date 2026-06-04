// GitHub Webhook HMAC-SHA256 signature verification
// Signature header format: "sha256=<hex-digest>"

export function verifyWebhookSignature(
  _payload: string,
  _signature: string,
  _secret: string,
): boolean {
  throw new Error("not implemented");
}
