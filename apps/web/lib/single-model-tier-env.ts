// Single-Model Shadow Tier — flag gates (Win 2).
//
// The tier recovers the HIGH/CRITICAL findings that only one of the two
// frontier reviewers flagged — dropped by the unanimous consensus gate.
// They are persisted + measurable but PRIVATE (canary-only render) until a
// brand decision. Three flags, layered:
//
//   1. isSingleModelTierEnabled() — env ANTFLEET_SINGLE_MODEL_TIER. Gates the
//      whole computation: selection (review-pipeline) + persistence (kernel).
//      Default OFF, so the feature is fully INERT until flipped.
//   2. isSingleModelTierEnabledForInstall(installationId, repo) — two-layer,
//      same pattern as precision-feedback-env.ts. Per-install override wins;
//      env fallback otherwise. Gates the per-install persistence + render.
//   3. isSingleModelTierRenderEnabled() — env-only sub-flag
//      ANTFLEET_SINGLE_MODEL_TIER_RENDER. Gates the canary PR-comment section.
//      Default OFF, so persistence (measurement) can run on a canary install
//      without ever rendering the section publicly.
//
// Render requires ALL of: tier-enabled-for-install AND this render sub-flag
// AND precision-feedback-enabled-for-install (so the dismiss ids are captured
// by the existing webhook path). The render is additionally suppressed by the
// disclosure/embargo layer — see review-worker's install lane.

import { db } from "@/db";
import { and, eq } from "drizzle-orm";
import { installations } from "@/db/schema";

export function isSingleModelTierEnabled(): boolean {
  const raw = process.env["ANTFLEET_SINGLE_MODEL_TIER"];
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}

/**
 * Resolves the effective enabled state for a specific install. Reads the
 * per-install override; falls back to the env flag when null.
 *
 * Lookup uses the (installation_id, repo) unique key — a single GitHub App
 * installation_id can be granted access to multiple repos, each yielding its
 * own installations row with its own override.
 *
 * Failure to read the row (DB hiccup) falls back to the env flag — the
 * conservative default. We never block shadow-tier collection because the
 * override lookup failed.
 */
export async function isSingleModelTierEnabledForInstall(
  installationId: number,
  repo: string,
): Promise<boolean> {
  let override: boolean | null = null;
  try {
    override = await loadInstallOverride(installationId, repo);
  } catch {
    // DB read failed — fall through to env default.
    return isSingleModelTierEnabled();
  }
  if (override !== null) return override;
  return isSingleModelTierEnabled();
}

async function loadInstallOverride(installationId: number, repo: string): Promise<boolean | null> {
  const rows = await db
    .select({ singleModelTierEnabled: installations.singleModelTierEnabled })
    .from(installations)
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .limit(1);
  return rows[0]?.singleModelTierEnabled ?? null;
}

// Render sub-flag (env-only). Layered UNDER the per-install tier flag — the
// render path must check the parent tier flag AND precision-feedback first,
// then this sub-flag. Default OFF: persistence/measurement runs on a canary
// install without ever surfacing the section.
export function isSingleModelTierRenderEnabled(): boolean {
  const raw = process.env["ANTFLEET_SINGLE_MODEL_TIER_RENDER"];
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}
