// Patch Agent v1.5 — flag gate.
//
// Two layers, in priority order:
//   1. Per-install override: installations.patchAgentEnabled (bool,
//      nullable). Non-null → that value wins, regardless of env. Used to
//      canary one install before flipping env-wide.
//   2. Env fallback: PATCH_AGENT_ENABLED. "true" / "1" → enabled.
//      Anything else (including unset) → disabled.
//
// The env-only check stays exported so PR4's review-worker tests can mock
// the install-aware path independently.

import { db } from "@/db";
import { eq } from "drizzle-orm";
import { installations } from "@/db/schema";

export function isPatchAgentEnabled(): boolean {
  const raw = process.env["PATCH_AGENT_ENABLED"];
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}

/**
 * Resolves the effective enabled state for a specific install. Reads the
 * per-install override; falls back to the env flag when null.
 *
 * Failure to read the row (DB hiccup) falls back to the env flag — the
 * conservative default. We never block patches because the override
 * lookup failed.
 */
export async function isPatchAgentEnabledForInstall(installationId: number): Promise<boolean> {
  let override: boolean | null = null;
  try {
    override = await loadInstallOverride(installationId);
  } catch {
    // DB read failed — fall through to env default.
    return isPatchAgentEnabled();
  }
  if (override !== null) return override;
  return isPatchAgentEnabled();
}

async function loadInstallOverride(installationId: number): Promise<boolean | null> {
  const rows = await db
    .select({ patchAgentEnabled: installations.patchAgentEnabled })
    .from(installations)
    .where(eq(installations.installationId, installationId))
    .limit(1);
  return rows[0]?.patchAgentEnabled ?? null;
}
