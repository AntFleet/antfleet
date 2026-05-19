import { createHash } from "node:crypto";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

const requestTimestampsByIpHash = new Map<string, number[]>();

export function checkRateLimit(
  ip: string,
  now = Date.now(),
): { allowed: boolean; retryAfterSec: number } {
  const ipHash = hashIp(ip);
  const cutoff = now - WINDOW_MS;
  const timestamps = (requestTimestampsByIpHash.get(ipHash) ?? []).filter(
    (timestamp) => timestamp > cutoff,
  );

  if (timestamps.length >= MAX_REQUESTS) {
    const oldestTimestamp = timestamps[0] ?? now;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((oldestTimestamp + WINDOW_MS - now) / 1000)),
    };
  }

  timestamps.push(now);
  requestTimestampsByIpHash.set(ipHash, timestamps);
  return { allowed: true, retryAfterSec: 0 };
}

export function resetRateLimitForTest(): void {
  requestTimestampsByIpHash.clear();
}

function hashIp(ip: string): string {
  // ROAST_IP_SALT is required and must be a >=16 char string; never store raw IPs.
  const salt = process.env["ROAST_IP_SALT"];
  if (!salt || salt.length < 16) {
    throw new Error("ROAST_IP_SALT must be set to a >=16 char string");
  }

  return createHash("sha256")
    .update(ip + salt)
    .digest("hex");
}
