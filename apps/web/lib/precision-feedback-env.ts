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
//
// Auto-retraction (item 6) is gated ADDITIONALLY behind its own sub-flag
// ANTFLEET_PRECISION_AUTORETRACT (env-only, default OFF). This lets capture
// (items 4–5) run on a canary install without auto-retracting public receipts.
// Only relevant when ANTFLEET_PRECISION_FEEDBACK is already ON for the install.
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

// ---------------------------------------------------------------------------
// Shared authorised-association guard.
//
// Used both by the webhook ingest path (route.ts) and the precisionWindow
// metric query (queries.ts). Single source of truth so they can't drift.
// ---------------------------------------------------------------------------
export const DISMISS_AUTHORISED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// Sub-flag for auto-retraction (Step 0.5, item 6).
//
// Layered UNDER isPrecisionFeedbackEnabledForInstall — callers must check
// the parent precision-feedback flag first, then this sub-flag. Env-only
// (no per-install override needed at this stage; one canary pattern is
// sufficient via the parent flag). Default OFF.
//
// Design note: keeping this env-only (rather than per-install) matches the
// spec's intent that capture (items 4–5) can run on a single canary install
// without auto-retracting public receipts site-wide. When the operator is
// ready to activate retraction, they flip this env flag knowing the parent
// flag has already been validated.
export function isPrecisionAutoRetractEnabled(): boolean {
  const raw = process.env["ANTFLEET_PRECISION_AUTORETRACT"];
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}
