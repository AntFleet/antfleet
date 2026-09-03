import { describe, expect, it } from "vitest";

import {
  type CalibrationReceipt,
  type CorpusFixture,
  type CorpusResult,
  type GenerationBinding,
  type PocEnablementManifest,
  type SampleManifestEntry,
  type ValidatePocEnablementInputs,
  pocDigest,
  validatePocEnablement,
} from "./poc-enablement.js";
import type { PocExecution } from "./poc.js";

const GEN: GenerationBinding = {
  modelId: "gpt-5.5",
  promptDigest: "tmpl-abc",
  configDigest: "cfg-xyz",
};

const EXEC_PASS = (path: string, kind: "static" | "harness"): PocExecution => ({
  executed: true,
  compiled: true,
  passed: true,
  drove: kind === "static",
  targetFrameObserved: true,
  deployedTargetPath: path,
  driveKind: kind === "static" ? "direct-revert" : "callback",
  reason: "",
});

/** A calibration receipt of a given class. `accept-static`/`accept-harness` are
 * would-promote (need a humanGenuine grade); `none` is non-would-promote. */
function mkReceipt(
  findingId: string,
  targetId: string,
  cls: "accept-static" | "accept-harness" | "none",
  humanGenuine: boolean | null = true,
): CalibrationReceipt {
  const path = `src/${targetId}.sol`;
  if (cls === "accept-static") {
    return {
      findingId,
      targetId,
      executeOnly: true,
      poc: {
        tier: "static-bound",
        assertionForm: "target-read",
        staticGate: { passed: true },
        target: { path, symbol: targetId },
        execution: EXEC_PASS(path, "static"),
      },
      humanGenuine,
    };
  }
  if (cls === "accept-harness") {
    return {
      findingId,
      targetId,
      executeOnly: true,
      poc: {
        tier: "harness-driven",
        assertionForm: "revert",
        staticGate: { passed: true },
        target: { path, symbol: targetId },
        execution: EXEC_PASS(path, "harness"),
      },
      humanGenuine,
    };
  }
  // non-would-promote: generated but not executed → wouldPromotePoc === null
  return {
    findingId,
    targetId,
    executeOnly: true,
    poc: {
      tier: "harness-driven",
      assertionForm: "no-revert",
      staticGate: { passed: true },
      target: { path, symbol: targetId },
      execution: null,
    },
    humanGenuine: null,
  };
}

type Built = {
  manifest: PocEnablementManifest;
  inputs: ValidatePocEnablementInputs;
  corpusManifest: CorpusFixture[];
  corpusResults: CorpusResult[];
  receipts: CalibrationReceipt[];
  sample: SampleManifestEntry[];
};

/** A fully-consistent, both-tiers-enabling baseline. Tests deep-clone + mutate it. */
function build(): Built {
  const corpusManifest: CorpusFixture[] = [
    {
      fixtureId: "f-static",
      kind: "known-true",
      driveKind: "direct-revert",
      targetId: "Vault",
      structuralClass: "direct",
      isDerSc: false,
      provenance: "synthetic",
    },
    {
      fixtureId: "f-dersc",
      kind: "known-true",
      driveKind: "callback",
      targetId: "RelativeIndexHook",
      structuralClass: "v4-hook",
      isDerSc: true,
      provenance: "antfleet-internal",
    },
    {
      fixtureId: "f-nondersc",
      kind: "known-true",
      driveKind: "callback",
      targetId: "VaultRouter",
      structuralClass: "erc4626-router",
      isDerSc: false,
      provenance: "public-disclosed",
    },
    {
      fixtureId: "f-taut",
      kind: "known-false",
      driveKind: null,
      targetId: "Vault",
      structuralClass: "hollow",
      isDerSc: false,
      provenance: "synthetic",
    },
    {
      fixtureId: "f-fakestd",
      kind: "known-false",
      driveKind: null,
      targetId: "Vault",
      structuralClass: "hollow",
      isDerSc: false,
      provenance: "synthetic",
    },
  ];
  const corpusResults: CorpusResult[] = [
    { fixtureId: "f-static", outcome: "promoted", promotedTier: "static-bound", skipped: false },
    { fixtureId: "f-dersc", outcome: "promoted", promotedTier: "harness-driven", skipped: false },
    {
      fixtureId: "f-nondersc",
      outcome: "promoted",
      promotedTier: "harness-driven",
      skipped: false,
    },
    { fixtureId: "f-taut", outcome: "rejected", promotedTier: null, skipped: false },
    { fixtureId: "f-fakestd", outcome: "rejected", promotedTier: null, skipped: false },
  ];

  // 20 sampled findings across 2 targets. 3 static accepts + 3 harness accepts + 14 none.
  const sample: SampleManifestEntry[] = [];
  const receipts: CalibrationReceipt[] = [];
  for (let i = 0; i < 20; i++) {
    const targetId = i % 2 === 0 ? "Vault" : "VaultRouter";
    const id = `find-${i}`;
    let cls: "accept-static" | "accept-harness" | "none" = "none";
    if (i < 3) cls = "accept-static";
    else if (i < 6) cls = "accept-harness";
    sample.push({ findingId: id, targetId });
    receipts.push(mkReceipt(id, targetId, cls));
  }

  const inputs: ValidatePocEnablementInputs = {
    executorSourceDigest: "exec-src-digest-v1",
    corpusManifest,
    calibrationReceipts: receipts,
    calibrationSampleManifest: sample,
    activeGeneration: GEN,
  };

  const manifest: PocEnablementManifest = {
    enableStatic: true,
    enableHarness: true,
    executorSourceDigest: "exec-src-digest-v1",
    generation: GEN,
    corpusAttestation: {
      corpusCommit: "abc123",
      corpusManifestDigest: pocDigest(corpusManifest),
      imageDigest: "sha256:img",
      ranAt: "2026-09-03T00:00:00Z",
      results: corpusResults,
      resultsDigest: pocDigest(corpusResults),
    },
    calibration: {
      ranAt: "2026-09-03T00:00:00Z",
      imageDigest: "sha256:img",
      sampleManifestDigest: pocDigest(sample),
      receiptsDigest: pocDigest(receipts),
    },
    audit: { ref: "audit-ref-1", executorCommitRange: "a..b" },
    approver: "augustas",
    date: "2026-09-03",
  };

  return { manifest, inputs, corpusManifest, corpusResults, receipts, sample };
}

/** Re-pin the calibration digests after mutating receipts/sample (so a test isolates the
 * rule under test rather than tripping a digest mismatch). */
function repin(b: Built): void {
  b.manifest.calibration.receiptsDigest = pocDigest(b.inputs.calibrationReceipts);
  b.manifest.calibration.sampleManifestDigest = pocDigest(b.inputs.calibrationSampleManifest);
  b.manifest.corpusAttestation.corpusManifestDigest = pocDigest(b.inputs.corpusManifest);
  b.manifest.corpusAttestation.resultsDigest = pocDigest(b.manifest.corpusAttestation.results);
}

describe("validatePocEnablement — valid baseline", () => {
  it("enables both tiers on a fully-consistent manifest", () => {
    const b = build();
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons, r.reasons.join(" | ")).toEqual([]);
    expect(r.enableStatic).toBe(true);
    expect(r.enableHarness).toBe(true);
  });
});

describe("validatePocEnablement — fail-closed on missing inputs", () => {
  for (const key of [
    "executorSourceDigest",
    "corpusManifest",
    "calibrationReceipts",
    "calibrationSampleManifest",
    "activeGeneration",
  ] as const) {
    it(`disables both tiers when ${key} is unavailable`, () => {
      const b = build();
      const inputs = { ...b.inputs, [key]: null };
      const r = validatePocEnablement(b.manifest, inputs);
      expect(r).toMatchObject({ enableStatic: false, enableHarness: false });
      expect(r.reasons.join(" ")).toMatch(/fail-closed/);
    });
  }
});

describe("validatePocEnablement — generation binding", () => {
  it("disables when the active generator differs (model swap)", () => {
    const b = build();
    const r = validatePocEnablement(b.manifest, {
      ...b.inputs,
      activeGeneration: { ...GEN, modelId: "other-model" },
    });
    expect(r).toMatchObject({ enableStatic: false, enableHarness: false });
    expect(r.reasons.join(" ")).toMatch(/generation-binding/);
  });
});

describe("validatePocEnablement — digest binding", () => {
  it("disables on executorSourceDigest mismatch", () => {
    const b = build();
    const r = validatePocEnablement(b.manifest, { ...b.inputs, executorSourceDigest: "tampered" });
    expect(r.reasons.join(" ")).toMatch(/executorSourceDigest/);
    expect(r.enableStatic).toBe(false);
  });

  it("disables when receiptsDigest does not match the receipts", () => {
    const b = build();
    b.inputs.calibrationReceipts = [...b.receipts, mkReceipt("extra", "Vault", "none")];
    // deliberately do NOT repin → digest mismatch
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/receiptsDigest/);
    expect(r.enableHarness).toBe(false);
  });

  it("disables when corpusManifestDigest does not match", () => {
    const b = build();
    const cf = b.corpusManifest[0];
    if (cf) cf.provenance = "changed-without-repin";
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/corpusManifestDigest/);
  });
});

describe("validatePocEnablement — corpus attestation (leg 1)", () => {
  it("disables when a corpus result was skipped", () => {
    const b = build();
    const r0 = b.manifest.corpusAttestation.results[0];
    if (r0) r0.skipped = true;
    b.manifest.corpusAttestation.resultsDigest = pocDigest(b.manifest.corpusAttestation.results);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/skipped/);
  });

  it("disables when the results fixtureId set ≠ committed manifest set", () => {
    const b = build();
    b.manifest.corpusAttestation.results = b.manifest.corpusAttestation.results.slice(0, 4);
    b.manifest.corpusAttestation.resultsDigest = pocDigest(b.manifest.corpusAttestation.results);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/fixtureId set/);
  });

  it("disables when a known-false fixture 'promoted' (wrong outcome)", () => {
    const b = build();
    const taut = b.manifest.corpusAttestation.results.find((x) => x.fixtureId === "f-taut");
    if (taut) taut.outcome = "promoted";
    b.manifest.corpusAttestation.resultsDigest = pocDigest(b.manifest.corpusAttestation.results);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/outcome/);
  });

  it("disables when a corpus fixture lacks provenance/clearance", () => {
    const b = build();
    const cf = b.corpusManifest[0];
    if (cf) cf.provenance = "";
    b.manifest.corpusAttestation.corpusManifestDigest = pocDigest(b.inputs.corpusManifest);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/provenance/);
  });
});

describe("validatePocEnablement — calibration (leg 2)", () => {
  it("disables when receipts are not a bijection over the sample (missing drawn id)", () => {
    const b = build();
    b.inputs.calibrationReceipts = b.receipts.slice(0, 19); // drop one
    // pad sample stays 20 → 19≠20 bijection break; repin so it's the bijection, not a digest, that fails
    repin(b);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/bijection/);
    expect(r).toMatchObject({ enableStatic: false, enableHarness: false });
  });

  it("disables when a receipt id is absent from the sample manifest (padding)", () => {
    const b = build();
    b.receipts[19] = mkReceipt("not-drawn", "Vault", "none");
    repin(b);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/bijection/);
  });

  it("disables when pursueSampled < 20", () => {
    const b = build();
    b.inputs.calibrationSampleManifest = b.sample.slice(0, 10);
    b.inputs.calibrationReceipts = b.receipts.slice(0, 10);
    repin(b);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/pursueSampled|MIN_PURSUE/);
  });

  it("disables when a would-promote receipt is un-graded (humanGenuine null)", () => {
    const b = build();
    b.receipts[0] = mkReceipt("find-0", "Vault", "accept-static", null);
    repin(b);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/un-graded|blind/i);
  });

  it("disables when a would-promote receipt was graded hollow (acceptedHollow > 0)", () => {
    const b = build();
    b.receipts[0] = mkReceipt("find-0", "Vault", "accept-static", false);
    repin(b);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/acceptedHollow/);
  });

  it("disables when a receipt is not executeOnly", () => {
    const b = build();
    const r6 = b.receipts[6];
    if (r6) r6.executeOnly = false;
    repin(b);
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/executeOnly/);
  });
});

describe("validatePocEnablement — per-tier floors + recorded-flag agreement", () => {
  it("harness disabled (enableStatic still true) when there is no non-der-sc callback positive", () => {
    const b = build();
    // make the non-der-sc corpus positive der-sc → harness anti-overfit floor fails
    const f = b.corpusManifest.find((x) => x.fixtureId === "f-nondersc");
    if (f) f.isDerSc = true;
    b.manifest.corpusAttestation.corpusManifestDigest = pocDigest(b.inputs.corpusManifest);
    // recorded flags must be set to the recompute or it rejects; here recompute = static:true, harness:false
    b.manifest.enableHarness = false;
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r).toMatchObject({ enableStatic: true, enableHarness: false });
    expect(r.reasons).toEqual([]);
  });

  it("static disabled when < 3 genuine static accepts in calibration", () => {
    const b = build();
    // turn one static accept into a 'none' → only 2 genuine static accepts
    b.receipts[0] = mkReceipt("find-0", "Vault", "none");
    repin(b);
    b.manifest.enableStatic = false; // recompute will be static:false
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r).toMatchObject({ enableStatic: false, enableHarness: true });
    expect(r.reasons).toEqual([]);
  });

  it("rejects when recorded enable* flags disagree with the recompute (flags not trusted)", () => {
    const b = build();
    // baseline recomputes to true/true; claim harness:false but leave inputs enabling → disagreement
    b.manifest.enableHarness = false;
    const r = validatePocEnablement(b.manifest, b.inputs);
    expect(r.reasons.join(" ")).toMatch(/disagree/);
    expect(r).toMatchObject({ enableStatic: false, enableHarness: false });
  });
});
