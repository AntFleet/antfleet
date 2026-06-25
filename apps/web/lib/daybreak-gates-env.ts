// Daybreak gates — flag readers for the reachability gate, patch verifier,
// repo threat model, and public evidence-bundle writer. Env flags default
// OFF in prod; bench scripts flip them in-process to true.
//
// Mirrors the patch-agent-env.ts shape so future per-install overrides
// (installations.reachabilityGateEnabled / installations.patchVerifyEnabled)
// can slot in with the same two-layer precedence: per-install row wins when
// non-null, env fallback otherwise. Until the per-install columns ship the
// helpers read the env flag only — keeps the shape stable while still
// gating prod behind a single env variable.

import { and, eq } from "drizzle-orm";
import { installations } from "@/db/schema";

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

function readBoolEnv(key: string): boolean {
  const raw = process.env[key];
  if (raw === undefined) return false;
  return TRUE_VALUES.has(raw.toLowerCase().trim());
}

export function isReachabilityGateEnabled(): boolean {
  return readBoolEnv("ANTFLEET_REACHABILITY_GATE");
}

export function isPatchVerifyEnabled(): boolean {
  return readBoolEnv("ANTFLEET_PATCH_VERIFY");
}

export function isThreatModelEnabled(): boolean {
  return readBoolEnv("ANTFLEET_THREAT_MODEL");
}

export function isEvidenceBundleEnabled(): boolean {
  return readBoolEnv("ANTFLEET_EVIDENCE_BUNDLE");
}

export function isDisclosureGateEnabled(): boolean {
  return (
    readBoolEnv("ANTFLEET_DISCLOSURE_GATE") && readBoolEnv("ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE")
  );
}

export function isDisclosureSideTableEnabled(): boolean {
  return readBoolEnv("ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE");
}

export function isSarifIngestEnabled(): boolean {
  return readBoolEnv("ANTFLEET_SARIF_INGEST");
}

export function isSarifExportEnabled(): boolean {
  return readBoolEnv("ANTFLEET_SARIF_EXPORT");
}

// Direct push to GitHub Code Scanning from the AntFleet worker. v2 path.
// Default OFF in prod. Reads ANTFLEET_CODESCANNING_PAT for the upload
// credential (needs the `security_events:write` scope — a PAT, not the
// installation token, because most GitHub App installs don't grant
// security_events). When OFF, the v1 customer-owned workflow is still
// the supported path.
export function isCodeScanningPushEnabled(): boolean {
  return readBoolEnv("ANTFLEET_CODESCANNING_PUSH");
}

// Cyber tier (Daybreak follow-up). When OFF the repo_tier table can hold
// any value but every visibility / disclosure / prompt-routing check
// collapses to 'default' — behavior is byte-identical to pre-cyber-tier.
// When ON the helpers in lib/cyber-tier.ts read the side table and route
// accordingly. Default OFF in prod, ON in bench.
export function isCyberTierEnabled(): boolean {
  return readBoolEnv("ANTFLEET_CYBER_TIER");
}

// Forward-compatible per-install resolvers. Until installations gains the
// nullable boolean columns (planned in a follow-up to 0041) these just
// return the env value. Once the columns exist, the inner lookup can
// land without churn at the call sites in review-worker.ts.
//
// installationId is nullable so paid rails (x402, ACP) which have no
// known installation can still run the gate — they fall through to the
// env-default boolean. The args are otherwise ignored today.
export async function isReachabilityGateEnabledForInstall(
  _installationId: number | null,
  _repo: string,
): Promise<boolean> {
  void _installationId;
  void _repo;
  return isReachabilityGateEnabled();
}

export async function isPatchVerifyEnabledForInstall(
  _installationId: number | null,
  _repo: string,
): Promise<boolean> {
  void _installationId;
  void _repo;
  return isPatchVerifyEnabled();
}

export async function isThreatModelEnabledForInstall(
  _installationId: number | null,
  _repo: string,
): Promise<boolean> {
  void _installationId;
  void _repo;
  return isThreatModelEnabled();
}

export async function isEvidenceBundleEnabledForInstall(
  _installationId: number | null,
  _repo: string,
): Promise<boolean> {
  void _installationId;
  void _repo;
  return isEvidenceBundleEnabled();
}

export async function isDisclosureGateEnabledForInstall(
  _installationId: number | null,
  _repo: string,
): Promise<boolean> {
  void _installationId;
  void _repo;
  return isDisclosureGateEnabled();
}

export async function isSarifIngestEnabledForInstall(
  installationId: number | null,
  repo: string,
): Promise<boolean> {
  if (!isSarifIngestEnabled() || installationId === null) return false;
  const { db } = await import("@/db");
  const rows = await db
    .select({ status: installations.status })
    .from(installations)
    .where(and(eq(installations.installationId, installationId), eq(installations.repo, repo)))
    .limit(1);
  return rows[0]?.status === "approved";
}

export async function isSarifExportEnabledForInstall(
  _installationId: number | null,
  _repo: string,
): Promise<boolean> {
  void _installationId;
  void _repo;
  return isSarifExportEnabled();
}
