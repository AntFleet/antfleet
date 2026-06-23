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
