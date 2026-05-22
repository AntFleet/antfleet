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
import { and, eq } from "drizzle-orm";
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
 * Lookup uses the (installation_id, repo) unique key from migration 0016 —
 * a single GitHub App installation_id can be granted access to multiple
 * repos, each yielding its own installations row with its own override.
 * v1.5-canary discovered this the hard way: shipping with only the
 * installation_id filter returned an arbitrary sibling row.
 *
 * Failure to read the row (DB hiccup) falls back to the env flag — the
 * conservative default. We never block patches because the override
 * lookup failed.
 */
export async function isPatchAgentEnabledForInstall(
  installationId: number,
  repo: string,
): Promise<boolean> {
  let override: boolean | null = null;
  try {
    override = await loadInstallOverride(installationId, repo);
  } catch {
    // DB read failed — fall through to env default.
    return isPatchAgentEnabled();
  }
  if (override !== null) return override;
  return isPatchAgentEnabled();
}

async function loadInstallOverride(installationId: number, repo: string): Promise<boolean | null> {
  const rows = await db
    .select({ patchAgentEnabled: installations.patchAgentEnabled })
    .from(installations)
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .limit(1);
  return rows[0]?.patchAgentEnabled ?? null;
}

// Patch Agent v1.6 — click-to-apply gate. Same two-layer pattern as v1.5:
// per-install override on installations.patchAgentClickApplyEnabled wins
// when non-null; env PATCH_AGENT_CLICK_APPLY_ENABLED otherwise. Independent
// of PATCH_AGENT_ENABLED so the rollouts can decouple (v1.5 stays on
// while v1.6 canaries on aeon-bench).
//
// Callers must ALSO check isPatchAgentEnabled* first — if the v1.5 lane
// is off there are no patches to attach a review comment to. The two
// flags are AND-ed at the worker; this helper only answers "is the
// click-apply lane permitted for this install".

export function isPatchAgentClickApplyEnabled(): boolean {
  const raw = process.env["PATCH_AGENT_CLICK_APPLY_ENABLED"];
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}

export async function isPatchAgentClickApplyEnabledForInstall(
  installationId: number,
  repo: string,
): Promise<boolean> {
  let override: boolean | null = null;
  try {
    override = await loadClickApplyInstallOverride(installationId, repo);
  } catch {
    return isPatchAgentClickApplyEnabled();
  }
  if (override !== null) return override;
  return isPatchAgentClickApplyEnabled();
}

async function loadClickApplyInstallOverride(
  installationId: number,
  repo: string,
): Promise<boolean | null> {
  const rows = await db
    .select({
      patchAgentClickApplyEnabled: installations.patchAgentClickApplyEnabled,
    })
    .from(installations)
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .limit(1);
  return rows[0]?.patchAgentClickApplyEnabled ?? null;
}
