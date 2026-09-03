// Phase-2 executor enablement — the committed `poc-enablement.json` manifest and
// `validatePocEnablement`, the code interlock that decides per-tier promotion
// (SOLIDITY_SIDECAR_POC_SPEC.md §0/§4). This is the non-circular successor to the
// removed spike's `validateSpikeGoArtifact()`-refuses-without-artifact gate: it
// records EXECUTOR correctness (the acceptance corpus) + a post-build real-run
// CALIBRATION, never a pre-build grade of model generation. It NEVER trusts the
// manifest's recorded `enable*` booleans — it recomputes them from digest-bound
// evidence and rejects a manifest whose recorded flag disagrees.
//
// Pure module: no Docker, no forge, no network — fully unit-testable. The Docker
// executor that PRODUCES the receipts this validates lives in `poc-executor.ts`.

import { createHash } from "node:crypto";

import { type PocAssertionForm, type PocExecution, type PocTier, wouldPromotePoc } from "./poc.js";

// --- Thresholds (§4/§5/§7) --------------------------------------------------

/** Calibration must draw at least this many unfiltered PURSUE findings (§5 test 11). */
export const MIN_PURSUE_SAMPLED = 20;
/** ...across at least this many distinct targets. */
export const MIN_SAMPLE_TARGETS = 2;
/** Per-tier minimum GENUINE (human-confirmed) would-promote accepts before a tier
 * enables — the vacuity floor, so `acceptedHollow===0` bounds the true rate at ~3/n
 * rather than being vacuous on a zero/near-zero/ungraded accept set (§4/§5). */
export const MIN_GENUINE_ACCEPTS_PER_TIER = 3;

// --- Manifest + input schemas (§4) ------------------------------------------

/** The generator identity the calibration measured (leg-3). `promptDigest`/`configDigest`
 * hash the generation TEMPLATE + model config, NOT the per-finding rendered prompt. */
export type GenerationBinding = {
  modelId: string;
  promptDigest: string;
  configDigest: string;
};

/** One committed corpus fixture's ground truth (the pinned corpus fixture manifest). */
export type CorpusFixture = {
  fixtureId: string;
  kind: "known-true" | "known-false";
  driveKind: "direct-revert" | "callback" | null;
  targetId: string;
  structuralClass: string;
  isDerSc: boolean;
  /** Public-repo clearance provenance (§5 test 9); a fixture without it is inadmissible. */
  provenance: string;
};

/** One attested corpus-run result (leg-1 — machine/CI produced). */
export type CorpusResult = {
  fixtureId: string;
  /** "promoted" for a known-true that reached its tier; "rejected" for a known-false
   * that stayed PURSUE. Compared against the fixture's expected outcome. */
  outcome: "promoted" | "rejected";
  /** The tier a known-true promoted to (for the per-tier positive requirement). */
  promotedTier: PocTier | null;
  /** MUST be false — a skipped corpus run can never read as green (§0/§4). */
  skipped: boolean;
};

export type CorpusAttestation = {
  corpusCommit: string;
  corpusManifestDigest: string;
  imageDigest: string;
  ranAt: string;
  results: CorpusResult[];
  resultsDigest: string;
};

/** The `wouldPromotePoc`-consumable evidence object for a calibration receipt. */
export type CalibrationReceiptPoc = {
  tier: PocTier | null;
  assertionForm: PocAssertionForm | null;
  staticGate: { passed: boolean };
  target: { path: string; symbol: string } | null;
  execution: PocExecution | null;
};

/** One out-of-tree calibration receipt (leg-2 — operator-attested). */
export type CalibrationReceipt = {
  findingId: string;
  targetId: string;
  executeOnly: boolean;
  poc: CalibrationReceiptPoc;
  /** Blind human genuineness grade. May be null ONLY for a non-would-promote row;
   * a would-promote row with null is rejected (blind-grade invariant). */
  humanGenuine: boolean | null;
};

/** One drawn sample id (the pre-registered calibration sample manifest). */
export type SampleManifestEntry = { findingId: string; targetId: string };

export type CalibrationAttestation = {
  ranAt: string;
  imageDigest: string;
  sampleManifestDigest: string;
  receiptsDigest: string;
};

export type PocEnablementManifest = {
  enableStatic: boolean;
  enableHarness: boolean;
  executorSourceDigest: string;
  generation: GenerationBinding;
  corpusAttestation: CorpusAttestation;
  calibration: CalibrationAttestation;
  audit: { ref: string; executorCommitRange: string };
  approver: string;
  date: string;
};

/** Out-of-band evidence the validator recomputes against (never the manifest's own
 * recorded scalars). All are required; a missing input fails closed. */
export type ValidatePocEnablementInputs = {
  /** Digest of the executor SOURCE subtree (stable across committing the manifest). */
  executorSourceDigest: string | null;
  /** The committed corpus fixture manifest (ground truth). */
  corpusManifest: CorpusFixture[] | null;
  /** The out-of-tree (`.omc/`) raw calibration receipts. */
  calibrationReceipts: CalibrationReceipt[] | null;
  /** The out-of-tree pre-registered calibration sample manifest. */
  calibrationSampleManifest: SampleManifestEntry[] | null;
  /** The current run's generator identity (leg-3). */
  activeGeneration: GenerationBinding | null;
};

/** Per-tier enablement — the shape threaded into `promoteWithPoc` as `activeGo`. */
export type PocEnablement = { enableStatic: boolean; enableHarness: boolean };

/** A validation that failed closed / rejected, carrying the reason (for logs + tests). */
export type PocEnablementResult = PocEnablement & { reasons: string[] };

const DISABLED = (reasons: string[]): PocEnablementResult => ({
  enableStatic: false,
  enableHarness: false,
  reasons,
});

// --- Canonical digest (stable JSON) -----------------------------------------

/** Deterministic JSON with lexicographically sorted object keys, so a digest is
 * independent of key order / whitespace. Arrays keep their order (order is
 * meaningful for receipts/results). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** SHA-256 hex of the canonical JSON of `value` — the digest scheme the manifest uses. */
export function pocDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// --- The interlock ----------------------------------------------------------

/** Recompute per-tier promotion enablement from digest-bound evidence, never trusting
 * the manifest's recorded `enable*` booleans. Returns both tiers false (fail-closed)
 * on any missing input, digest mismatch, generation mismatch, structural violation,
 * or a recorded-flag disagreement. §4. */
export function validatePocEnablement(
  manifest: PocEnablementManifest,
  inputs: ValidatePocEnablementInputs,
): PocEnablementResult {
  const {
    executorSourceDigest,
    corpusManifest,
    calibrationReceipts,
    calibrationSampleManifest,
    activeGeneration,
  } = inputs;

  // Fail closed if any evidence input is unavailable (installed pkg / CI / no repo).
  if (
    executorSourceDigest === null ||
    corpusManifest === null ||
    calibrationReceipts === null ||
    calibrationSampleManifest === null ||
    activeGeneration === null
  ) {
    return DISABLED(["fail-closed: a validator evidence input is unavailable"]);
  }

  // --- Leg 3: generation binding (cheap; do first) --------------------------
  if (
    activeGeneration.modelId !== manifest.generation.modelId ||
    activeGeneration.promptDigest !== manifest.generation.promptDigest ||
    activeGeneration.configDigest !== manifest.generation.configDigest
  ) {
    return DISABLED(["generation-binding mismatch: active generator ≠ calibrated generator"]);
  }

  // --- Digest binding -------------------------------------------------------
  if (executorSourceDigest !== manifest.executorSourceDigest) {
    return DISABLED(["executorSourceDigest mismatch"]);
  }
  if (pocDigest(corpusManifest) !== manifest.corpusAttestation.corpusManifestDigest) {
    return DISABLED(["corpusManifestDigest mismatch"]);
  }
  if (pocDigest(manifest.corpusAttestation.results) !== manifest.corpusAttestation.resultsDigest) {
    return DISABLED(["resultsDigest mismatch"]);
  }
  if (pocDigest(calibrationReceipts) !== manifest.calibration.receiptsDigest) {
    return DISABLED(["receiptsDigest mismatch"]);
  }
  if (pocDigest(calibrationSampleManifest) !== manifest.calibration.sampleManifestDigest) {
    return DISABLED(["sampleManifestDigest mismatch"]);
  }

  // --- Leg 1: corpus attestation (machine/CI-verified) ----------------------
  const corpusReasons = validateCorpus(corpusManifest, manifest.corpusAttestation.results);
  if (corpusReasons.length > 0) {
    return DISABLED(corpusReasons);
  }

  // --- Leg 2: calibration receipts (operator-attested, recomputed) ----------
  const cal = validateCalibration(calibrationReceipts, calibrationSampleManifest);
  if (cal.reasons.length > 0) {
    return DISABLED(cal.reasons);
  }

  // --- Per-tier positive requirements ---------------------------------------
  // Tier-1 (CONFIRMED): ≥1 genuine Tier-1 known-true corpus member.
  const staticCorpusPositive = corpusManifest.some(
    (f) =>
      f.kind === "known-true" &&
      byId(manifest.corpusAttestation.results, f.fixtureId)?.promotedTier === "static-bound",
  );
  // Tier-2 (POC_EXECUTED): ≥1 genuine CALLBACK known-true, AND ≥1 on a NON-der-sc target
  // (anti-overfit floor).
  const harnessKnownTrue = corpusManifest.filter(
    (f) =>
      f.kind === "known-true" &&
      f.driveKind === "callback" &&
      byId(manifest.corpusAttestation.results, f.fixtureId)?.promotedTier === "harness-driven",
  );
  // `.some` is false for an empty list, so this also requires ≥1 callback known-true.
  const harnessCorpusPositive = harnessKnownTrue.some((f) => !f.isDerSc);

  // Recomputed per-tier enablement: legs pass ∧ per-tier corpus positive ∧
  // ≥MIN genuine accepts of that tier in calibration.
  const enableStatic =
    staticCorpusPositive && cal.genuineAccepts.static >= MIN_GENUINE_ACCEPTS_PER_TIER;
  const enableHarness =
    harnessCorpusPositive && cal.genuineAccepts.harness >= MIN_GENUINE_ACCEPTS_PER_TIER;

  // Recorded flags are NOT trusted: reject if either disagrees with the recompute.
  if (manifest.enableStatic !== enableStatic || manifest.enableHarness !== enableHarness) {
    return DISABLED([
      `recorded enable flags disagree with recompute (recorded ` +
        `${manifest.enableStatic}/${manifest.enableHarness}, recomputed ` +
        `${enableStatic}/${enableHarness})`,
    ]);
  }

  return { enableStatic, enableHarness, reasons: [] };
}

function byId(results: CorpusResult[], fixtureId: string): CorpusResult | undefined {
  return results.find((r) => r.fixtureId === fixtureId);
}

/** Leg-1: every result non-skipped, fixtureId set === manifest set, outcomes match the
 * fixture's expected direction. Returns reasons (empty === pass). */
function validateCorpus(manifest: CorpusFixture[], results: CorpusResult[]): string[] {
  const reasons: string[] = [];
  const manifestIds = new Set(manifest.map((f) => f.fixtureId));
  const resultIds = new Set(results.map((r) => r.fixtureId));
  if (manifestIds.size !== manifest.length) {
    reasons.push("corpus manifest has duplicate fixtureIds");
  }
  if (resultIds.size !== results.length) {
    reasons.push("corpus results have duplicate fixtureIds");
  }
  if (manifestIds.size !== resultIds.size || [...manifestIds].some((id) => !resultIds.has(id))) {
    reasons.push("corpus results fixtureId set ≠ committed corpus manifest set");
  }
  for (const f of manifest) {
    if (f.provenance.trim() === "") {
      reasons.push(`corpus fixture ${f.fixtureId} lacks provenance/clearance`);
    }
    const r = byId(results, f.fixtureId);
    if (r === undefined) {
      continue; // set-equality reason above already covers it
    }
    if (r.skipped !== false) {
      reasons.push(`corpus fixture ${f.fixtureId} was skipped`);
    }
    const expected = f.kind === "known-true" ? "promoted" : "rejected";
    if (r.outcome !== expected) {
      reasons.push(`corpus fixture ${f.fixtureId} outcome ${r.outcome} ≠ expected ${expected}`);
    }
  }
  return reasons;
}

/** Leg-2: bijection receipts↔sample, denominator from the sample manifest, executeOnly,
 * blind-grade invariant, acceptedHollow===0, and per-tier genuine-accept counts. */
function validateCalibration(
  receipts: CalibrationReceipt[],
  sample: SampleManifestEntry[],
): { reasons: string[]; genuineAccepts: { static: number; harness: number } } {
  const reasons: string[] = [];
  const zero = { static: 0, harness: 0 };

  const sampleIds = new Set(sample.map((s) => s.findingId));
  const receiptIds = new Set(receipts.map((r) => r.findingId));
  if (sampleIds.size !== sample.length) {
    reasons.push("calibration sample manifest has duplicate findingIds");
  }
  if (receiptIds.size !== receipts.length) {
    reasons.push("calibration receipts have duplicate findingIds");
  }
  // Bijection: every drawn id has exactly one receipt and vice versa.
  if (
    sampleIds.size !== receiptIds.size ||
    [...sampleIds].some((id) => !receiptIds.has(id)) ||
    [...receiptIds].some((id) => !sampleIds.has(id))
  ) {
    reasons.push("calibration receipts are not a bijection over the sample manifest");
  }

  // Denominator from the PINNED sample manifest, never receipts.length.
  const pursueSampled = sample.length;
  if (pursueSampled < MIN_PURSUE_SAMPLED) {
    reasons.push(`pursueSampled ${pursueSampled} < MIN_PURSUE_SAMPLED ${MIN_PURSUE_SAMPLED}`);
  }
  const sampleTargets = new Set(sample.map((s) => s.targetId));
  if (sampleTargets.size < MIN_SAMPLE_TARGETS) {
    reasons.push(`sample target diversity ${sampleTargets.size} < ${MIN_SAMPLE_TARGETS}`);
  }

  const genuineAccepts = { static: 0, harness: 0 };
  let acceptedHollow = 0;
  for (const r of receipts) {
    if (r.executeOnly !== true) {
      reasons.push(`calibration receipt ${r.findingId} is not executeOnly`);
    }
    const earned = wouldPromotePoc({
      poc: {
        tier: r.poc.tier,
        assertionForm: r.poc.assertionForm,
        staticGate: { passed: r.poc.staticGate.passed, reasons: [] },
        target:
          r.poc.target === null
            ? null
            : {
                path: r.poc.target.path,
                symbol: r.poc.target.symbol,
                kind: "contract",
                derivation: "calibration",
              },
      },
      execution: r.poc.execution,
    });
    if (earned === null) {
      continue; // non-would-promote rows: humanGenuine may be null; not counted.
    }
    // Blind-grade invariant: a would-promote row MUST be graded.
    if (r.humanGenuine === null) {
      reasons.push(
        `would-promote calibration receipt ${r.findingId} is un-graded (humanGenuine null)`,
      );
      continue;
    }
    if (r.humanGenuine === false) {
      acceptedHollow += 1;
    } else if (earned === "static-bound") {
      genuineAccepts.static += 1;
    } else if (earned === "harness-driven") {
      genuineAccepts.harness += 1;
    }
  }
  if (acceptedHollow > 0) {
    reasons.push(`acceptedHollow ${acceptedHollow} > 0 (a real-sample false accept was confirmed)`);
  }

  return { reasons, genuineAccepts: reasons.length > 0 ? zero : genuineAccepts };
}
