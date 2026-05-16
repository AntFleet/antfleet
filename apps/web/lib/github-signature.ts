import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

// Verify GitHub's X-Hub-Signature-256 header against the raw request body.
// HMAC-SHA256, hex-encoded, with the webhook secret as the key. Comparison is
// constant-time to avoid signature-length oracle attacks.
export function verifyGitHubSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (signatureHeader === null || !signatureHeader.startsWith(PREFIX)) {
    return false;
  }
  const provided = signatureHeader.slice(PREFIX.length);
  if (provided.length !== 64 || !/^[0-9a-f]{64}$/u.test(provided)) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Both buffers are guaranteed 32 bytes from a hex-decoded sha256 digest.
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}
