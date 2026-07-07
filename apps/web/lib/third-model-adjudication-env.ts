// 3rd-Model Adjudication — flag gates (Build B).
//
// Extends Win2's single-model shadow tier. After the shadow tier is derived,
// one independent 3rd-model (GLM 5.2, Build A adapter) confirm/reject call runs
// per shadow HIGH/CRITICAL finding; a `confirm` graduates it to the
// `two_of_three` corroborated sub-tier. Corroborated rows STAY inside the
// source='single_model' shadow tier (already reader-guarded), so this build
// adds NO new public surface — it is a private, canary-only measurement axis.
//
// Two flags, layered UNDER Win2's tier flags (adjudication only runs on a
// shadow tier that was itself enabled for the install):
//
//   1. isThirdModelAdjudicationEnabled() — env ANTFLEET_THIRD_MODEL_ADJUDICATION.
//      Gates the whole adjudication step. Default OFF, so the feature is fully
//      INERT until flipped.
//   2. isThirdModelAdjudicationEnabledForInstall(installationId, repo) —
//      two-layer, same pattern as single-model-tier-env.ts. Per-install
//      override wins; env fallback otherwise.

import { db } from "@/db";
import { and, eq } from "drizzle-orm";
import { installations } from "@/db/schema";

export function isThirdModelAdjudicationEnabled(): boolean {
  const raw = process.env["ANTFLEET_THIRD_MODEL_ADJUDICATION"];
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
 * conservative default. We never block adjudication because the override
 * lookup failed; the applier itself is fail-open on the LLM call.
 */
export async function isThirdModelAdjudicationEnabledForInstall(
  installationId: number,
  repo: string,
): Promise<boolean> {
  let override: boolean | null = null;
  try {
    override = await loadInstallOverride(installationId, repo);
  } catch {
    // DB read failed — fall through to env default.
    return isThirdModelAdjudicationEnabled();
  }
  if (override !== null) return override;
  return isThirdModelAdjudicationEnabled();
}

async function loadInstallOverride(installationId: number, repo: string): Promise<boolean | null> {
  const rows = await db
    .select({
      thirdModelAdjudicationEnabled: installations.thirdModelAdjudicationEnabled,
    })
    .from(installations)
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .limit(1);
  return rows[0]?.thirdModelAdjudicationEnabled ?? null;
}
