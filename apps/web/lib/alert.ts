// Minimal critical-event alert hook. Sends a sanitized payload to a
// configurable webhook (Slack/Discord/generic) when ANTFLEET_ALERT_WEBHOOK_URL
// is set. No-op when unset. Fire-and-forget — the fetch is never awaited on
// the hot path; alert failure is logged but never propagates to the caller.
//
// Use alertCritical() only for terminal, non-retryable failures. Do NOT call
// it on transient errors that will be retried — that would produce alert
// storms with no actionable signal.
//
// Payload sanitization: strip keys whose names contain "key", "secret",
// "token", "authorization", or "password" (case-insensitive); truncate
// string values to 200 chars so raw provider response bodies cannot leak.

import { logError } from "./log";

export type AlertPayload = Record<string, unknown>;

// Mutable fetch reference. Production code always uses globalThis.fetch.
// Tests override this via the alertTestSeam export below.
let fetchImpl: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);

/**
 * Test seam — allows unit tests to inject a mock fetch without patching
 * globalThis. Never import this in production code paths.
 */
export const alertTestSeam = {
  setFetch(impl: typeof globalThis.fetch): void {
    fetchImpl = impl;
  },
  resetFetch(): void {
    fetchImpl = (...args) => globalThis.fetch(...args);
  },
};

const SENSITIVE_KEY_PATTERN = /key|secret|token|authorization|password/i;

function sanitize(payload: AlertPayload): AlertPayload {
  const result: AlertPayload = {};
  for (const [k, v] of Object.entries(payload)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) continue;
    if (typeof v === "string") {
      result[k] = v.slice(0, 200);
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      result[k] = v;
    } else {
      // Nested objects / arrays: stringify + truncate. Keeps the payload
      // flat and prevents leaking deeply-nested credentials.
      result[k] = JSON.stringify(v).slice(0, 200);
    }
  }
  return result;
}

/**
 * Fire-and-forget critical alert. Sends to ANTFLEET_ALERT_WEBHOOK_URL when
 * set; otherwise a no-op. Never throws — alert failure is logged internally.
 *
 * @param event  Structured event name, e.g. "worker.failed".
 * @param payload Flat context object. Sensitive keys and long strings are
 *                stripped / truncated before sending.
 */
export function alertCritical(event: string, payload: AlertPayload = {}): void {
  const url = process.env["ANTFLEET_ALERT_WEBHOOK_URL"];
  if (!url || url.trim() === "") return;

  const body = JSON.stringify({
    text: `[antfleet] CRITICAL: ${event}`,
    event,
    payload: sanitize(payload),
    ts: new Date().toISOString(),
  });

  // Fire-and-forget: intentionally not awaited.
  void fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logError("alert.webhook_failed", { event, message });
  });
}
