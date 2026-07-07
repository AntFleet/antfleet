// Precision Feedback — flag gate (Step 0.5, item 3).
//
// Two layers, in priority order:
//   1. Per-install override: installations.precisionFeedbackEnabled (bool,
//      nullable). Non-null → that value wins, regardless of env. Used to
//      canary one install (e.g. aeon-bench) before flipping env-wide.
//   2. Env fallback: ANTFLEET_PRECISION_FEEDBACK. "true" / "1" → enabled.
//      Anything else (including unset) → disabled (default OFF).
//
// Gates: footer affordance, dismiss-reply ingestion, auto-retraction.
// Nothing is gated on this flag yet (items 4–6 in Step 0.5 build order).
//
// The env-only check stays exported so future tests can mock the
// install-aware path independently (same pattern as patch-agent-env.ts).

import { db } from "@/db";
import { and, eq } from "drizzle-orm";
import { installations } from "@/db/schema";

export function isPrecisionFeedbackEnabled(): boolean {
  const raw = process.env["ANTFLEET_PRECISION_FEEDBACK"];
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}

/**
 * Resolves the effective enabled state for a specific install. Reads the
 * per-install override; falls back to the env flag when null.
 *
 * Lookup uses the (installation_id, repo) unique key from migration 0016 —
 * a single GitHub App installation_id can be granted access to multiple
 * repos, each yielding its own installations row with its own override.
 *
 * Failure to read the row (DB hiccup) falls back to the env flag — the
 * conservative default. We never block signal collection because the
 * override lookup failed.
 */
export async function isPrecisionFeedbackEnabledForInstall(
  installationId: number,
  repo: string,
): Promise<boolean> {
  let override: boolean | null = null;
  try {
    override = await loadInstallOverride(installationId, repo);
  } catch {
    // DB read failed — fall through to env default.
    return isPrecisionFeedbackEnabled();
  }
  if (override !== null) return override;
  return isPrecisionFeedbackEnabled();
}

async function loadInstallOverride(installationId: number, repo: string): Promise<boolean | null> {
  const rows = await db
    .select({ precisionFeedbackEnabled: installations.precisionFeedbackEnabled })
    .from(installations)
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .limit(1);
  return rows[0]?.precisionFeedbackEnabled ?? null;
}
