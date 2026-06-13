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
