// Shared review-worker timing constants. Hoisted out of review-worker.ts so
// db/queries.ts can read the attempts cap without importing the worker (which
// itself depends on queries → would cycle).
//
// Backoff sequence. Indexed by the attempts counter AFTER the failure
// (so a 1st-attempt failure picks index 0 → 60s, 2nd → 120s, …). The
// length is the terminal threshold: after that many failures the row is
// marked failed rather than scheduled for another retry. Total wall-clock
// from first failure to terminal ≈ 60+120+240+480+960+1800 ≈ 62 minutes.
export const BACKOFF_SECONDS = [60, 120, 240, 480, 960, 1800] as const;
export const MAX_PROCESSING_ATTEMPTS = BACKOFF_SECONDS.length;

// A row that has been claimed and stuck in in_progress for longer than
// this is considered abandoned — the cron re-claims it. Picked to be
// well above a normal review's runtime (Pro plan maxDuration is 300s);
// 5 minutes gives the worker headroom to finish the slowest observed
// PRs without the cron stomping on a still-running attempt.
export const STUCK_AFTER_MS = 5 * 60 * 1000;

// Heuristic: which errors are worth retrying. The cheap signal we have
// is the error message string — the SDKs we use (Anthropic, OpenAI,
// Octokit) all surface HTTP status codes in the message. Anything that
// looks like a transient infra problem (429, 5xx, fetch failed, timeout)
// is retryable. Anything that looks like our own bug or a 4xx other
// than 429 is not — retrying won't help and we'd burn LLM budget.
//
// Lives in this leaf config module (not review-worker.ts) so review-
// pipeline.ts can classify a per-provider failure's transience WITHOUT
// importing the worker (review-worker imports review-pipeline → a direct
// import back would cycle). review-worker.ts re-exports it for its own
// callers.
export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("rate_limit")) {
    return true;
  }
  if (
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504")
  ) {
    return true;
  }
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
    return true;
  }
  if (
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused")
  ) {
    return true;
  }
  if (lower.includes("fetch failed") || lower.includes("network")) {
    return true;
  }
  // Deterministic failures the comment above always intended to exclude but
  // never enforced: a re-run with the same input cannot help, so retrying only
  // burns LLM budget cycling to the attempts cap. Checked AFTER the transient
  // allowlist so a message carrying both signals (e.g. a timeout that mentions
  // a 4xx) still errs retryable.
  //
  // Deliberately NOT denylisted: model schema/parse failures. Those are
  // STOCHASTIC — a re-sample frequently returns a valid shape (the #134
  // recovery case) — so they must fall through to retryable below. Their Zod
  // messages don't carry these HTTP-status substrings, so they're unaffected.
  if (
    lower.includes("401") ||
    lower.includes("403") ||
    lower.includes("invalid api key") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication")
  ) {
    return false; // auth / credential — identical retry can't fix it
  }
  if (
    lower.includes("413") ||
    lower.includes("context length") ||
    lower.includes("context_length") ||
    lower.includes("maximum context") ||
    lower.includes("too many tokens") ||
    lower.includes("token limit") ||
    lower.includes("payload too large") ||
    lower.includes("request too large")
  ) {
    return false; // input too large — identical input fails identically
  }
  // Unknown pipeline throws are almost certainly infrastructure; err on the
  // retryable side. The attempts cap still stops the bleeding.
  return true;
}
