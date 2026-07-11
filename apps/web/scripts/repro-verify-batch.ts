#!/usr/bin/env tsx
// Contained CI repro-execution batch (issue #133 Build 2b-2 / #145 part 2) —
// the runner side of the prove-the-bug verifier (lib/repro-verifier.ts).
//
// runReproVerifier EXECUTES model-generated code (the generated repro `cmd`).
// The process-level hardening inside repro-verifier.ts (minimalEnv secret-strip,
// /tmp worktree, wall-clock SIGKILL timeout, teardown) is NOT a security
// boundary against attacker-authored code — the 2026-07-11 audit was explicit
// that it MUST be paired with a disposable, secretless CI runner before the
// ANTFLEET_REPRO_EXEC flag is turned on. This script is that runner's brain.
//
// Containment model = a 3-PHASE split, orchestrated by the accompanying
// .github/workflows/repro-exec-verify.yml so each phase runs in a step with a
// DIFFERENT secret posture:
//
//   fetch  (WITH secrets: DATABASE_URL + ANTHROPIC_API_KEY + GITHUB_TOKEN)
//     - reads candidate CONSENSUS findings that carry a suggested patch from the
//       DB, calls the real anthropic provider to GENERATE a repro spec per
//       finding, materialises a disposable bare git MIRROR of the source repo
//       pinned to the reviewed SHA, and writes the specs (each carrying its
//       mirror path) to a JSON file. Executes no model code. This is the only
//       phase allowed near secrets, the model API, and the network.
//
//   exec   (NO secrets at all — the security-critical phase)
//     - FIRST asserts no secret is present in process.env (assertNoSecretsInEnv,
//       fail CLOSED, named-list + suffix-pattern). This proves the workflow's
//       per-step env separation held.
//     - Then flips ANTFLEET_REPRO_EXEC on FOR THIS PROCESS ONLY, reads the specs
//       file, and runs each through runReproVerifier in OFFLINE mode (clone from
//       the pre-materialised mirror — no network). The workflow additionally
//       wraps this step with an egress lockdown so the model repro has no
//       network at all. Writes verdicts to a JSON file. No DB, no provider, no
//       secret.
//
//   record (WITH the DB secret, but WRITE-gated + idempotent)
//     - reads the verdicts file and, only when --record is passed, writes one
//       review_gate_outcomes row per verdict (stage "repro_verify"), SKIPPING
//       any (reviewId, findingId, stage) that already has a row. Default is a
//       dry-run that prints what it WOULD write and touches nothing.
//
// The flag stays OFF in the app. Nothing here flips it except the exec phase's
// own process and the workflow's exec step. Run with:
//   tsx scripts/repro-verify-batch.ts --phase <fetch|exec|record> [flags]

import { config as loadDotenv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Finding } from "@/lib/review-types";
import type { ReproTestSuggestion } from "@antfleet/cli/types";
import type { PatchVerifyOutcome } from "@/lib/patch-verifier";

// ── Secrets the exec phase must NEVER see, by EXPLICIT name. Kept as a named
// constant so the assertion and its test reference the same list. Two vars
// (DATABASE_URL, ANTHROPIC_API_KEY) do NOT match the suffix pattern below, so
// they MUST stay here. A value counts as "present" only when it is a non-empty
// string (an exported-but-empty var is harmless). This list is the audit-named
// ~20 app secrets plus the obvious infra ones.
const FORBIDDEN_EXEC_SECRETS = [
  // Do not match the suffix pattern — must be explicit.
  "DATABASE_URL",
  "POSTGRES_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ZHIPU_API_KEY",
  "VIRTUALS_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_PUBLIC_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "CRON_SECRET",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
  "X402_SMOKE_PRIVATE_KEY",
  "ANTFLEET_CODESCANNING_PAT",
  "ANTFLEET_OPS_GH_TOKEN",
  "ROAST_GH_TOKEN",
  "DISCLOSURE_HMAC_SECRET",
  "OPTIN_HMAC_SECRET",
  "OPERATOR_SECRET",
  "ANTFLEET_SARIF_INGEST_HMAC_SECRET",
  "AEON_GATE_SECRETS",
] as const;

// ── Suffix / substring PATTERN for secret-shaped env var names the explicit
// list may not enumerate. Any var whose NAME ends in one of these (case
// insensitive) OR contains PRIVATE_KEY is treated as a secret and refused —
// MINUS the allowlist below. This is the fail-closed backstop: a newly added
// FOO_TOKEN / BAR_API_KEY leaks into the exec step and this catches it without a
// code change.
const SECRET_NAME_PATTERN = /(_SECRET|_KEY|_TOKEN|_PAT|_PASSWORD|PRIVATE_KEY|_HMAC)$/i;
const CONTAINS_PRIVATE_KEY = /PRIVATE_KEY/i;

// ── Conservative allowlist of KNOWN-safe, non-secret var names that would
// otherwise trip the pattern (or that we deliberately permit in the exec step).
// EXACT-name matches only — no prefixes here except the explicit ANTFLEET_*
// feature-flag booleans + CI/runner metadata families handled by ALLOWLIST_PREFIXES.
const ALLOWLIST_EXACT = new Set<string>([
  // The exec phase deliberately sets this ON for its own process.
  "ANTFLEET_REPRO_EXEC",
  // GitHub Actions metadata (non-secret; the runner exports these).
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_WORKSPACE",
  "GITHUB_ACTION",
  "GITHUB_ACTOR",
  "GITHUB_JOB",
  "GITHUB_EVENT_NAME",
  "GITHUB_API_URL",
  "GITHUB_SERVER_URL",
  "GITHUB_GRAPHQL_URL",
  // Common shell / toolchain vars.
  "CI",
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "SHLVL",
  "TERM",
  "USER",
  "LOGNAME",
  "LANG",
  "TZ",
  "TMPDIR",
]);

// Prefixes whose entire family is non-secret and allowlisted. ANTFLEET_* are the
// feature-flag booleans (ANTFLEET_REPRO_EXEC etc.) and public URLs; if any real
// secret is ever named ANTFLEET_* it MUST also live in FORBIDDEN_EXEC_SECRETS
// (as ANTFLEET_CODESCANNING_PAT / ANTFLEET_OPS_GH_TOKEN / the SARIF HMAC do),
// and the explicit-name check runs FIRST so those still fail closed.
const ALLOWLIST_PREFIXES = ["ANTFLEET_", "RUNNER_", "NODE_", "npm_config_", "XDG_"] as const;

const DEFAULT_FETCH_LIMIT = 5;
const DEFAULT_SPECS_PATH = "repro-specs.json";
const DEFAULT_VERDICTS_PATH = "repro-verdicts.json";

// The stage value written to review_gate_outcomes for this side-table. The DB
// column is plain free-text (no enum), so the record phase casts it at the call
// site (see realGateWriter) — kept as a shared constant so the idempotency probe
// and the writer agree.
const REPRO_VERIFY_STAGE = "repro_verify";

// How far back to look for candidate findings, mirroring bench-dryrun's window.
const RECENT_DAYS = 90;
// Row cap on the candidate SQL — a safety ceiling so an enormous --limit cannot
// pull unbounded rows. The `source='consensus' AND suggested_patch IS NOT NULL`
// filters run in SQL BEFORE this cap so it only ever bounds ELIGIBLE rows.
const CANDIDATE_SCAN_CEILING = 500;

// ── Spec shape emitted by fetch, consumed by exec. This is the ONLY thing that
// crosses the secretless boundary — deliberately just the inputs runReproVerifier
// needs, no DB rows or credentials. `mirrorDir` is the disposable bare mirror the
// fetch phase created (pinned to `sha`) so exec clones OFFLINE. `specDigest` is a
// stable content hash used in the recorded evidence.
export type ReproSpec = {
  reviewId: string;
  findingId: string;
  findingIndex: number;
  repoUrl: string;
  mirrorDir: string;
  sha: string;
  patch: string;
  repro: ReproTestSuggestion;
  specDigest: string;
};

// ── Verdict shape emitted by exec, consumed by record. A flat, serialisable
// projection of the verifier outcome — enriched (FIX 6) so the recorded evidence
// is self-describing without re-joining the spec: the sha, the repro/test/detector
// details, the pre/post exit codes, the timings, and the model / spec digest.
export type VerdictRecord = {
  reviewId: string;
  findingId: string;
  verdict: PatchVerifyOutcome["verdict"];
  inconclusiveReason: PatchVerifyOutcome["inconclusiveReason"];
  sha: string;
  reproCmd: string | null;
  detector: string;
  testExitCode: number | null;
  reproPreExitCode: number | null;
  reproPostExitCode: number | null;
  testMs: number | null;
  reproPreMs: number | null;
  reproPostMs: number | null;
  totalMs: number;
  modelId: string | null;
  specDigest: string;
  notes: string;
};

// The three verdict strings a repro run can produce. Used by parseVerdicts's
// strict shape check (FIX 6) so a corrupt artifact is rejected loudly.
const VERDICT_VALUES = new Set(["verified", "regressed", "inconclusive"]);

// ────────────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────────────

// Minimal `--flag value` / `--bool` parser. No dependency; mirrors the ad-hoc
// argv handling other scripts in this dir use. Returns a lookup over the args
// AFTER argv[2] so `--phase` and friends are all visible.
export function parseArgs(argv: readonly string[]): {
  get: (flag: string) => string | null;
  has: (flag: string) => boolean;
} {
  const args = argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    if (i === -1) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return null;
    return v;
  };
  const has = (flag: string): boolean => args.includes(flag);
  return { get, has };
}

// True iff `name` is an allowlisted, known-safe non-secret var name. EXACT match
// or an allowlisted prefix. The explicit FORBIDDEN check always runs first, so a
// forbidden ANTFLEET_* secret is caught before this ever permits it.
function isAllowlistedEnvName(name: string): boolean {
  if (ALLOWLIST_EXACT.has(name)) return true;
  return ALLOWLIST_PREFIXES.some((p) => name.startsWith(p));
}

// HARD, fail-closed guard for the exec phase. Throws if ANY secret is present
// and non-empty in process.env, by BOTH the explicit named list AND a
// suffix/substring pattern (minus a conservative allowlist). This is the proof
// that the workflow's exec step really did run without secrets — if the env
// separation ever regresses (a secret leaks into the exec step), this stops the
// run BEFORE a single line of model-generated code executes. Exported for tests.
export function assertNoSecretsInEnv(env: Record<string, string | undefined> = process.env): void {
  const present = (v: string | undefined): v is string => typeof v === "string" && v.length > 0;

  // 1) Explicit named secrets (includes the two that don't match the pattern).
  const named = FORBIDDEN_EXEC_SECRETS.filter((k) => present(env[k]));

  // 2) Pattern backstop: any non-empty var whose NAME looks secret-shaped and is
  //    not allowlisted. De-duplicate against the named list.
  const namedSet = new Set<string>(named);
  const patterned: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!present(value)) continue;
    if (namedSet.has(key)) continue;
    if (isAllowlistedEnvName(key)) continue;
    if (SECRET_NAME_PATTERN.test(key) || CONTAINS_PRIVATE_KEY.test(key)) {
      patterned.push(key);
    }
  }

  const leaked = [...named, ...patterned];
  if (leaked.length > 0) {
    throw new Error(
      `[repro-verify-batch] REFUSING to execute model-generated code: secret(s) present in the ` +
        `exec environment: ${leaked.join(", ")}. The exec phase MUST run in a secretless step; ` +
        `this fail-closed guard proves the CI env separation held. Do NOT add secrets to the ` +
        `exec step (add a genuinely-safe var to the allowlist if it is a false positive).`,
    );
  }
}

// A stable, short content digest for a spec — sha256 over the fields that
// determine the run (repo, sha, patch, repro cmd/file). Recorded in the evidence
// so a verdict is traceable to the exact inputs that produced it, and used to
// tag which spec a record came from. Sync (node:crypto) — no IO.
export function computeSpecDigest(input: {
  repoUrl: string;
  sha: string;
  patch: string;
  repro: ReproTestSuggestion;
}): string {
  const material = JSON.stringify({
    repoUrl: input.repoUrl,
    sha: input.sha,
    patch: input.patch,
    cmd: input.repro.cmd,
    file: input.repro.file,
    modelId: input.repro.modelId,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

// Project a verifier outcome onto the flat, ENRICHED record the record phase
// persists. Pure + exported so the unit tests can assert the mapping without
// spawning. reproPre/PostExitCode + timings are OPTIONAL on PatchVerifyOutcome
// (an early bail may omit them); normalise the missing case to null.
export function shapeVerdictRecord(spec: ReproSpec, outcome: PatchVerifyOutcome): VerdictRecord {
  return {
    reviewId: spec.reviewId,
    findingId: spec.findingId,
    verdict: outcome.verdict,
    inconclusiveReason: outcome.inconclusiveReason,
    sha: spec.sha,
    reproCmd: outcome.reproCmd ?? spec.repro.cmd,
    detector: outcome.detector,
    testExitCode: outcome.testExitCode,
    reproPreExitCode: outcome.reproPreExitCode ?? null,
    reproPostExitCode: outcome.reproPostExitCode ?? null,
    testMs: outcome.testMs,
    reproPreMs: outcome.reproPreMs ?? null,
    reproPostMs: outcome.reproPostMs ?? null,
    totalMs: outcome.ms,
    modelId: spec.repro.modelId,
    specDigest: spec.specDigest,
    notes: outcome.notes,
  };
}

// ────────────────────────────────────────────────────────────────────────
// fetch phase — WITH secrets. Selects CONSENSUS candidates that carry a
// suggested patch + generates repro specs + materialises the offline mirror.
// Executes no model code.
// ────────────────────────────────────────────────────────────────────────

// Candidate row: a review paired with its CONSENSUS finding_status rows that
// carry a suggested patch. Each status carries the DB's own correct pairing keys
// — findingIndex (integer, positional into agreementDecision.agreed[]) and
// source (text) — so the fetch phase never re-derives them from the id shape.
type CandidateRow = {
  reviewId: string;
  owner: string;
  repo: string;
  commitSha: string;
  prNumber: number;
  agreementDecision: unknown;
  findingStatuses: Array<{
    findingId: string;
    findingIndex: number;
    source: string;
    suggestedPatch: string;
  }>;
};

// Agreed-finding projection, copied in spirit from bench-dryrun so the finding
// reconstruction is identical across the two scripts.
type AgreedFinding = {
  title: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  evidence: Array<{ path: string; startLine: number | null; endLine: number | null }>;
  reasoning: string;
  reproduction: string | null;
  recommendation: string;
};

export type FetchPhaseOptions = {
  // Caps GENERATION ATTEMPTS — the number of candidate (consensus-finding-with-a
  // -patch) rows processed — NOT the number of emitted specs. A declined /
  // errored / no-repro attempt STILL consumes one unit of the cap.
  limit: number;
  repo: string | null;
  outPath: string;
  // Injectable so the (DB + provider + github + mirror) surface can be mocked in
  // tests. Production omits it and the phase wires the real ones lazily.
  deps?: FetchDeps;
  // Injectable spec sink, for tests. Production omits it and writes outPath.
  writeSpecs?: (specs: ReproSpec[]) => Promise<void>;
  log?: (msg: string) => void;
};

// The async surfaces the fetch phase touches, behind one injectable seam
// (mirrors bench-dryrun's lazy dynamic imports, but hoisted to a param so tests
// stay hermetic). All are loaded lazily in the real wiring — no top-level DB
// import.
export type FetchDeps = {
  // Pushes the source='consensus' + suggested_patch IS NOT NULL + optional repo
  // filters into SQL BEFORE any row cap. Returns at most `scanCeiling` eligible
  // candidate rows within the recency window.
  loadCandidates: (
    repo: string | null,
    scanCeiling: number,
  ) => Promise<{ rows: CandidateRow[]; scanned: number; sinceIso: string }>;
  fetchChangedFiles: (
    owner: string,
    repo: string,
    prNumber: number,
    sha: string,
  ) => Promise<ReadonlyArray<{ filename: string; contents: string }>>;
  generateRepro: (args: {
    reviewId: string;
    finding: Finding;
    findingId: string;
    changedFiles: ReadonlyArray<{ filename: string; contents: string }>;
  }) => Promise<ReproTestSuggestion | null>;
  // Materialise a disposable bare git mirror of `repoUrl` pinned to `sha`, so the
  // exec phase can clone OFFLINE. Returns the mirror dir. Injectable so tests
  // never touch git / the network.
  createMirror: (repoUrl: string, sha: string) => Promise<string>;
};

export async function runFetchPhase(opts: FetchPhaseOptions): Promise<ReproSpec[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const deps = opts.deps ?? (await realFetchDeps());

  const { rows, scanned, sinceIso } = await deps.loadCandidates(opts.repo, CANDIDATE_SCAN_CEILING);
  log(
    `[fetch] window since ${sinceIso}; scanned ${scanned} recent review(s); ` +
      `${rows.length} carry a consensus finding with a suggested patch` +
      (opts.repo !== null ? ` (repo filter ${opts.repo})` : ""),
  );
  if (scanned >= CANDIDATE_SCAN_CEILING) {
    log(
      `[fetch] scan hit the ${CANDIDATE_SCAN_CEILING}-row ceiling — older candidates may be ` +
        `truncated; narrow with --repo or shorten the window if you need them`,
    );
  }

  const specs: ReproSpec[] = [];
  let attempts = 0;
  let dropped = 0;
  const skips = new Map<string, number>();
  const noteSkip = (reason: string, findingId: string, detail: string) => {
    dropped++;
    skips.set(reason, (skips.get(reason) ?? 0) + 1);
    log(`[fetch] skip ${findingId} (${reason}): ${detail}`);
  };

  // A --limit unit is one GENERATION ATTEMPT (a consensus-finding-with-a-patch we
  // decide to process), consumed even when the attempt declines / errors. A
  // finding dropped BEFORE an attempt (no paired agreed entry, no evidence) does
  // NOT consume the cap — it never reached the model.
  outer: for (const row of rows) {
    const agreed = extractAgreed(row.agreementDecision);
    let changedFiles: ReadonlyArray<{ filename: string; contents: string }> | null = null;

    for (const status of row.findingStatuses) {
      if (attempts >= opts.limit) break outer;

      // FIX 1: index the RAW agreed[] array POSITIONALLY by the DB's findingIndex.
      // Never compact/renumber — a malformed earlier entry must not shift a later
      // finding onto the wrong agreed record. A missing / malformed entry is
      // skipped (does NOT consume the cap — no model call was made).
      const agreedFinding = agreed[status.findingIndex];
      if (agreedFinding === undefined || agreedFinding === null) {
        noteSkip(
          "malformed-agreed-entry",
          status.findingId,
          `agreed[${status.findingIndex}] is missing or malformed`,
        );
        continue;
      }
      // No evidence path → the verifier can't anchor a repro. Drop at pairing
      // time rather than spend a generation call (does NOT consume the cap).
      if (agreedFinding.evidence.length === 0) {
        noteSkip(
          "no-evidence",
          status.findingId,
          `agreed finding at index ${status.findingIndex} has no evidence path`,
        );
        continue;
      }

      // Committed to a generation attempt for this finding — consumes the cap.
      attempts++;

      if (changedFiles === null) {
        changedFiles = await deps.fetchChangedFiles(
          row.owner,
          row.repo,
          row.prNumber,
          row.commitSha,
        );
      }

      const finding = reconstructFinding(agreedFinding);
      let repro: ReproTestSuggestion | null;
      try {
        repro = await deps.generateRepro({
          reviewId: row.reviewId,
          finding,
          findingId: status.findingId,
          changedFiles,
        });
      } catch (err) {
        noteSkip(
          "generation-error",
          status.findingId,
          `repro generation threw: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (repro === null) {
        noteSkip("generation-error", status.findingId, "generation returned no repro (skipped)");
        continue;
      }
      if (repro.cmd === null) {
        noteSkip(
          "generation-declined",
          status.findingId,
          `model declined a repro${repro.rationale !== null ? ` (${repro.rationale})` : ""}`,
        );
        continue;
      }

      // Materialise the offline mirror only once we have a runnable repro —
      // avoids a clone for a finding the model declined.
      const repoUrl = `https://github.com/${row.owner}/${row.repo}.git`;
      let mirrorDir: string;
      try {
        mirrorDir = await deps.createMirror(repoUrl, row.commitSha);
      } catch (err) {
        noteSkip(
          "mirror-error",
          status.findingId,
          `mirror creation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      specs.push({
        reviewId: row.reviewId,
        findingId: status.findingId,
        findingIndex: status.findingIndex,
        repoUrl,
        mirrorDir,
        sha: row.commitSha,
        patch: status.suggestedPatch,
        repro,
        specDigest: computeSpecDigest({
          repoUrl,
          sha: row.commitSha,
          patch: status.suggestedPatch,
          repro,
        }),
      });
    }
  }

  const skipSummary =
    skips.size === 0
      ? "none"
      : [...skips.entries()].map(([reason, n]) => `${reason}=${n}`).join(" ");
  log(
    `[fetch] ${attempts} generation attempt(s) (limit ${opts.limit}); emitted ${specs.length} ` +
      `runnable spec(s); dropped ${dropped} (${skipSummary})`,
  );
  if (opts.writeSpecs) {
    await opts.writeSpecs(specs);
  } else {
    await writeFile(opts.outPath, JSON.stringify(specs, null, 2), "utf8");
    log(`[fetch] wrote specs to ${opts.outPath}`);
  }
  return specs;
}

// ────────────────────────────────────────────────────────────────────────
// exec phase — NO secrets. Executes the model-generated repros OFFLINE.
// Security-critical.
// ────────────────────────────────────────────────────────────────────────

export type ExecPhaseOptions = {
  inPath: string;
  outPath: string;
  // Injectable verifier seam. Production omits it and the phase binds the real
  // runReproVerifier + realReproVerifierIo lazily (OFFLINE mode); tests inject a
  // stub so no subprocess is ever spawned.
  runVerifier?: (spec: ReproSpec) => Promise<PatchVerifyOutcome>;
  // Injectable spec source, for tests. Production omits it and reads inPath.
  loadSpecs?: () => Promise<ReproSpec[]>;
  // Injectable sink, for tests. Production omits it and writes outPath.
  writeVerdicts?: (records: VerdictRecord[]) => Promise<void>;
  log?: (msg: string) => void;
};

export async function runExecPhase(opts: ExecPhaseOptions): Promise<VerdictRecord[]> {
  const log = opts.log ?? ((m: string) => console.log(m));

  // FAIL CLOSED before anything else: no secret may be present in the exec
  // environment. Proves the workflow's per-step secret separation held.
  assertNoSecretsInEnv();

  // Flip the exec gate ON for THIS PROCESS ONLY. This is the sole place the app
  // flag is enabled outside the workflow's exec step; runReproVerifier is a
  // no-op (inconclusive repro_exec_disabled) without it.
  process.env["ANTFLEET_REPRO_EXEC"] = "true";

  const runVerifier = opts.runVerifier ?? (await realVerifier());
  const specs = opts.loadSpecs
    ? await opts.loadSpecs()
    : parseSpecs(await readFile(opts.inPath, "utf8"));
  log(`[exec] loaded ${specs.length} spec(s) from ${opts.inPath}`);

  const records: VerdictRecord[] = [];
  for (const spec of specs) {
    let outcome: PatchVerifyOutcome;
    try {
      outcome = await runVerifier(spec);
    } catch (err) {
      // A verifier throw is itself an inconclusive result — never let one bad
      // spec abort the batch. Shape a synthetic inconclusive record (enriched
      // from the spec so it stays self-describing).
      records.push({
        reviewId: spec.reviewId,
        findingId: spec.findingId,
        verdict: "inconclusive",
        inconclusiveReason: "exception",
        sha: spec.sha,
        reproCmd: spec.repro.cmd,
        detector: "none",
        testExitCode: null,
        reproPreExitCode: null,
        reproPostExitCode: null,
        testMs: null,
        reproPreMs: null,
        reproPostMs: null,
        totalMs: 0,
        modelId: spec.repro.modelId,
        specDigest: spec.specDigest,
        notes: `runReproVerifier threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    records.push(shapeVerdictRecord(spec, outcome));
  }

  const counts = summariseVerdicts(records);
  log(
    `[exec] done — verified=${counts.verified} regressed=${counts.regressed} ` +
      `inconclusive=${counts.inconclusive} (total ${records.length})`,
  );

  if (opts.writeVerdicts) {
    await opts.writeVerdicts(records);
  } else {
    await writeFile(opts.outPath, JSON.stringify(records, null, 2), "utf8");
    log(`[exec] wrote verdicts to ${opts.outPath}`);
  }
  return records;
}

export function summariseVerdicts(records: readonly VerdictRecord[]): {
  verified: number;
  regressed: number;
  inconclusive: number;
} {
  const counts = { verified: 0, regressed: 0, inconclusive: 0 };
  for (const r of records) {
    if (r.verdict === "verified") counts.verified++;
    else if (r.verdict === "regressed") counts.regressed++;
    else counts.inconclusive++;
  }
  return counts;
}

// ────────────────────────────────────────────────────────────────────────
// record phase — WITH the DB secret, but WRITE-gated + idempotent. Default
// dry-run.
// ────────────────────────────────────────────────────────────────────────

export type RecordPhaseOptions = {
  inPath: string;
  record: boolean;
  // Injectable writer seam. Production omits it and binds recordGateOutcome
  // lazily; the dry-run path never touches it. Tests inject a spy to assert it
  // is NOT called without --record.
  writeGateOutcome?: (
    reviewId: string,
    row: { findingId: string; verdict: string; evidence: unknown },
  ) => Promise<void>;
  // Idempotency probe (FIX 6): true iff a review_gate_outcomes row already exists
  // for (reviewId, findingId, stage). Injectable; production binds the real
  // lookup lazily. When it returns true the row is SKIPPED (logged) rather than
  // duplicated. In dry-run this is consulted so the plan reflects reality.
  gateOutcomeExists?: (reviewId: string, findingId: string, stage: string) => Promise<boolean>;
  // Injectable verdict source, for tests. Production reads inPath.
  loadVerdicts?: () => Promise<VerdictRecord[]>;
  log?: (msg: string) => void;
};

export async function runRecordPhase(opts: RecordPhaseOptions): Promise<number> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const verdicts = opts.loadVerdicts
    ? await opts.loadVerdicts()
    : parseVerdicts(await readFile(opts.inPath, "utf8"));
  log(`[record] loaded ${verdicts.length} verdict(s) from ${opts.inPath}`);

  const exists = opts.gateOutcomeExists ?? (await realGateExists());

  if (!opts.record) {
    log("[record] DRY-RUN (no --record) — the following rows WOULD be written:");
    let wouldWrite = 0;
    let wouldSkip = 0;
    for (const v of verdicts) {
      if (await exists(v.reviewId, v.findingId, REPRO_VERIFY_STAGE)) {
        wouldSkip++;
        log(
          `[record]   SKIP (already recorded) review=${v.reviewId} finding=${v.findingId} ` +
            `stage=${REPRO_VERIFY_STAGE}`,
        );
        continue;
      }
      wouldWrite++;
      log(
        `[record]   review=${v.reviewId} finding=${v.findingId} stage=${REPRO_VERIFY_STAGE} ` +
          `verdict=${v.verdict}`,
      );
    }
    log(
      `[record] dry-run complete; wrote nothing (${wouldWrite} row(s) WOULD write, ` +
        `${wouldSkip} already recorded)`,
    );
    return 0;
  }

  const write = opts.writeGateOutcome ?? (await realGateWriter());
  let written = 0;
  let skipped = 0;
  for (const v of verdicts) {
    // IDEMPOTENT: skip a verdict already recorded for (review, finding, stage).
    if (await exists(v.reviewId, v.findingId, REPRO_VERIFY_STAGE)) {
      skipped++;
      log(`[record] already recorded — skipping review=${v.reviewId} finding=${v.findingId}`);
      continue;
    }
    await write(v.reviewId, {
      findingId: v.findingId,
      verdict: v.verdict,
      // Persist the full enriched record as evidence so the row is
      // self-describing (sha, repro/test details, exit codes, timings, digest).
      evidence: v,
    });
    written++;
  }
  log(
    `[record] wrote ${written} review_gate_outcomes row(s) (stage=${REPRO_VERIFY_STAGE}); ` +
      `skipped ${skipped} already-recorded`,
  );
  return written;
}

// ────────────────────────────────────────────────────────────────────────
// Parsing helpers (exported for tests) — tolerant JSON readers that fail LOUD
// on a malformed artifact so a corrupt file never silently produces an empty or
// wrong run.
// ────────────────────────────────────────────────────────────────────────

export function parseSpecs(json: string): ReproSpec[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("repro-specs file did not contain a JSON array");
  return parsed as ReproSpec[];
}

// STRICT (FIX 6): validate EACH record's shape, not just "is an array". A
// corrupt / partially-written verdicts file is rejected loudly rather than
// silently persisted. Checks: reviewId + findingId non-empty strings, verdict in
// the known set, and the exit codes are number|null.
export function parseVerdicts(json: string): VerdictRecord[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("repro-verdicts file did not contain a JSON array");
  const isNumOrNull = (x: unknown): x is number | null => x === null || typeof x === "number";
  const nonEmptyStr = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  parsed.forEach((rec, i) => {
    if (rec === null || typeof rec !== "object") {
      throw new Error(`repro-verdicts[${i}] is not an object`);
    }
    const r = rec as Record<string, unknown>;
    if (!nonEmptyStr(r["reviewId"])) {
      throw new Error(`repro-verdicts[${i}].reviewId must be a non-empty string`);
    }
    if (!nonEmptyStr(r["findingId"])) {
      throw new Error(`repro-verdicts[${i}].findingId must be a non-empty string`);
    }
    if (typeof r["verdict"] !== "string" || !VERDICT_VALUES.has(r["verdict"])) {
      throw new Error(
        `repro-verdicts[${i}].verdict must be one of verified|regressed|inconclusive`,
      );
    }
    if (!isNumOrNull(r["testExitCode"])) {
      throw new Error(`repro-verdicts[${i}].testExitCode must be number|null`);
    }
    if (!isNumOrNull(r["reproPreExitCode"])) {
      throw new Error(`repro-verdicts[${i}].reproPreExitCode must be number|null`);
    }
    if (!isNumOrNull(r["reproPostExitCode"])) {
      throw new Error(`repro-verdicts[${i}].reproPostExitCode must be number|null`);
    }
  });
  return parsed as VerdictRecord[];
}

// ── Finding reconstruction — kept in spirit with bench-dryrun's projection so a
// finding fed here is the one the patch verifier would have seen.
function reconstructFinding(agreed: AgreedFinding): Finding {
  return {
    title: agreed.title,
    category: agreed.category as never,
    severity: agreed.severity,
    label: "blocking",
    confidence: "low",
    evidence: agreed.evidence.map((e) => ({
      path: e.path,
      startLine: e.startLine,
      endLine: e.endLine,
      symbol: null,
      quote: null,
    })),
    reasoning: agreed.reasoning,
    reproduction: agreed.reproduction,
    recommendation: agreed.recommendation,
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    requiresPolicyReview: false,
    upstreamOrigin: null,
  };
}

// POSITION-PRESERVING (FIX 1): return the raw agreed[] array aligned to its
// ORIGINAL indices, mapping each element to a parsed AgreedFinding OR null when
// that element is malformed. NEVER compacts or renumbers — the DB's findingIndex
// is a positional key into agreementDecision.agreed[], so a dropped/shifted
// element would pair a suggestedPatch with the WRONG finding. Callers read
// `out[findingIndex]` and treat null/undefined as "no paired finding".
function extractAgreed(agreementDecision: unknown): (AgreedFinding | null)[] {
  if (agreementDecision === null || typeof agreementDecision !== "object") return [];
  const obj = agreementDecision as Record<string, unknown>;
  const agreed = obj["agreed"];
  if (!Array.isArray(agreed)) return [];
  return agreed.map((item): AgreedFinding | null => {
    if (item === null || typeof item !== "object") return null;
    const f = item as Record<string, unknown>;
    const title = typeof f["title"] === "string" ? f["title"] : null;
    const category = typeof f["category"] === "string" ? f["category"] : null;
    const severity = f["severity"];
    if (title === null || category === null) return null;
    if (
      severity !== "critical" &&
      severity !== "high" &&
      severity !== "medium" &&
      severity !== "low"
    ) {
      return null;
    }
    const evidence = Array.isArray(f["evidence"]) ? f["evidence"] : [];
    return {
      title,
      category,
      severity,
      evidence: evidence
        .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
        .map((e) => ({
          path: typeof e["path"] === "string" ? e["path"] : "",
          startLine: typeof e["startLine"] === "number" ? e["startLine"] : null,
          endLine: typeof e["endLine"] === "number" ? e["endLine"] : null,
        })),
      reasoning: typeof f["reasoning"] === "string" ? f["reasoning"] : "",
      reproduction: typeof f["reproduction"] === "string" ? f["reproduction"] : null,
      recommendation: typeof f["recommendation"] === "string" ? f["recommendation"] : "",
    };
  });
}

// ────────────────────────────────────────────────────────────────────────
// Real dependency wiring — lazy dynamic imports ONLY (mirrors bench-dryrun).
// No top-level DB / provider import so importing this module for tests is inert.
// ────────────────────────────────────────────────────────────────────────

async function realFetchDeps(): Promise<FetchDeps> {
  const { db } = await import("@/db");
  const { reviews, findingStatus } = await import("@/db/schema");
  const { sql, eq, and, gte, isNotNull } = await import("drizzle-orm");
  const { getPublicChangedFiles, PublicRepoAccessError } =
    await import("@/lib/github-files-public");
  const { generateReproTest } = await import("@/lib/repro-generation");
  const { anthropicProvider } = await import("@antfleet/cli/providers/anthropic");

  // Build the ReproProposingProvider adapter off the real anthropic provider,
  // mirroring how patch-agent.ts builds its PatchProposingProvider from
  // anthropicProvider.proposePatch. Single-model (anthropic) per Build 2's
  // repro-generation contract.
  if (typeof anthropicProvider.proposeReproTest !== "function") {
    throw new Error(
      "[repro-verify-batch] anthropic provider is missing proposeReproTest; cannot generate repros",
    );
  }
  const reproProvider = {
    name: anthropicProvider.name,
    proposeReproTest: anthropicProvider.proposeReproTest.bind(anthropicProvider),
  };

  return {
    loadCandidates: async (repoFilter, scanCeiling) => {
      const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
      // Push source='consensus' + suggested_patch IS NOT NULL + optional repo
      // filter into SQL BEFORE the row cap, so the ceiling only ever bounds
      // ELIGIBLE rows (FIX 2). Join finding_status to reviews and select the
      // DB's own pairing keys (finding_index, source) — never the id shape.
      const conds = [
        gte(reviews.createdAt, since),
        eq(findingStatus.source, "consensus"),
        isNotNull(findingStatus.suggestedPatch),
      ];
      if (repoFilter !== null) {
        const [ownerF, repoF] = repoFilter.split("/");
        if (ownerF !== undefined && repoF !== undefined) {
          conds.push(eq(reviews.owner, ownerF));
          conds.push(eq(reviews.repo, repoF));
        }
      }
      const joined = await db
        .select({
          reviewId: reviews.reviewId,
          owner: reviews.owner,
          repo: reviews.repo,
          prNumber: reviews.prNumber,
          commitSha: reviews.commitSha,
          agreementDecision: reviews.agreementDecision,
          createdAt: reviews.createdAt,
          findingId: findingStatus.findingId,
          findingIndex: findingStatus.findingIndex,
          source: findingStatus.source,
          suggestedPatch: findingStatus.suggestedPatch,
        })
        .from(reviews)
        .innerJoin(findingStatus, eq(findingStatus.reviewId, reviews.reviewId))
        .where(and(...conds))
        .orderBy(sql`${reviews.createdAt} DESC`)
        .limit(scanCeiling);

      // Group the flat join back into per-review candidate rows, preserving the
      // DB pairing keys on each status.
      const byReview = new Map<string, CandidateRow>();
      const seenReviews = new Set<string>();
      for (const r of joined) {
        seenReviews.add(r.reviewId);
        if (r.owner === null || r.repo === null || r.suggestedPatch === null) continue;
        let row = byReview.get(r.reviewId);
        if (row === undefined) {
          row = {
            reviewId: r.reviewId,
            owner: r.owner,
            repo: r.repo,
            prNumber: r.prNumber,
            commitSha: r.commitSha,
            agreementDecision: r.agreementDecision,
            findingStatuses: [],
          };
          byReview.set(r.reviewId, row);
        }
        row.findingStatuses.push({
          findingId: r.findingId,
          findingIndex: r.findingIndex,
          source: r.source,
          suggestedPatch: r.suggestedPatch,
        });
      }
      return {
        rows: [...byReview.values()],
        scanned: seenReviews.size,
        sinceIso: since.toISOString(),
      };
    },
    fetchChangedFiles: async (owner, repo, prNumber, sha) => {
      try {
        const files = await getPublicChangedFiles({ owner, repo, prNumber, headSha: sha });
        return files.map((f) => ({ filename: f.filename, contents: f.contents }));
      } catch (err) {
        if (err instanceof PublicRepoAccessError) {
          console.warn(`[fetch] ${owner}/${repo}#${prNumber} private/404 — no source window`);
        } else {
          console.warn(`[fetch] file fetch failed for ${owner}/${repo}: ${(err as Error).message}`);
        }
        return [];
      }
    },
    generateRepro: async ({ reviewId, finding, findingId, changedFiles }) => {
      const result = await generateReproTest({
        reviewId,
        findings: [finding],
        findingIds: [findingId],
        changedFiles: changedFiles.map((f) => ({
          filename: f.filename,
          contents: f.contents,
          status: "changed" as const,
          sha: "",
          patch: null,
        })),
        provider: reproProvider,
      });
      const proposal = result.proposals[0];
      return proposal?.reproTest ?? null;
    },
    createMirror: async (repoUrl, sha) => realCreateMirror(repoUrl, sha),
  };
}

// Materialise a disposable BARE git mirror of repoUrl pinned to `sha`, so the
// exec phase can clone OFFLINE with NO network. Steps:
//   1. mkdtemp a fresh dir under tmpdir()/antfleet-mirror-<uuid> (per-mirror,
//      disposable; a later 2b hardening mounts it read-only).
//   2. `git clone --bare <repoUrl> <dir>` — the full mirror.
//   3. PIN the reviewed SHA under a durable ref: `git -C <dir> fetch origin
//      <sha>:refs/pinned/<sha>`. A bare clone may not carry the exact SHA as a
//      ref, and an offline raw-SHA fetch FAILS under git protocol v0 (which
//      rejects an unadvertised object). Pinning it under refs/pinned/<sha> makes
//      it advertised + GC-durable so the exec-phase `git fetch <sha>` resolves.
// repoUrl + sha are validated (isSafeRepoUrl / isSafeSha) so nothing model- or
// user-controlled reaches git argv unchecked; the `--` separators are the
// second layer.
async function realCreateMirror(repoUrl: string, sha: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { isSafeRepoUrl, isSafeSha } = await import("@/lib/patch-verifier");
  const run = promisify(execFile);

  if (!isSafeRepoUrl(repoUrl)) throw new Error(`unsafe repoUrl for mirror: ${repoUrl}`);
  if (!isSafeSha(sha)) throw new Error(`unsafe sha for mirror: ${sha}`);

  const dir = await mkdtemp(join(tmpdir(), `antfleet-mirror-${randomUUID()}-`));
  // Full bare mirror. `--` guards the URL from being read as a flag.
  await run("git", ["clone", "--bare", "--quiet", "--", repoUrl, dir]);
  // Pin the reviewed SHA under a durable, advertised ref so an offline raw-SHA
  // fetch works under any protocol version and the object survives GC.
  await run("git", ["-C", dir, "fetch", "--quiet", "origin", "--", `${sha}:refs/pinned/${sha}`]);
  return dir;
}

async function realVerifier(): Promise<(spec: ReproSpec) => Promise<PatchVerifyOutcome>> {
  const { runReproVerifier, realReproVerifierIo } = await import("@/lib/repro-verifier");
  // OFFLINE: clone from the pre-materialised mirror the fetch phase created —
  // the exec sandbox needs NO network. runReproVerifier reads ZERO fields of
  // args.finding for any security decision (confirmed against the module), so a
  // minimal placeholder is safe here; the spec does not carry the reconstructed
  // Finding across the secretless boundary.
  return async (spec: ReproSpec) =>
    runReproVerifier({
      repoSource: { kind: "offline", mirrorDir: spec.mirrorDir },
      sha: spec.sha,
      patch: spec.patch,
      repro: spec.repro,
      finding: minimalFindingForVerify(),
      io: await realReproVerifierIo(),
    });
}

// runReproVerifier requires a Finding on args but reads NONE of its fields for a
// security decision (verified/regressed/inconclusive is driven entirely by the
// repro cmd + patch + test suite). The spec does not carry the reconstructed
// Finding across the secretless boundary (it is DB-derived), so we pass this
// minimal placeholder.
function minimalFindingForVerify(): Finding {
  return {
    title: "(repro-exec replay)",
    category: "security" as never,
    severity: "low",
    label: "blocking",
    confidence: "low",
    evidence: [],
    reasoning: "",
    reproduction: null,
    recommendation: "",
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    requiresPolicyReview: false,
    upstreamOrigin: null,
  };
}

async function realGateWriter(): Promise<
  (
    reviewId: string,
    row: { findingId: string; verdict: string; evidence: unknown },
  ) => Promise<void>
> {
  const { recordGateOutcome } = await import("@/db/queries");
  return async (reviewId, row) => {
    // `stage` is typed on GateOutcomeRow as the two shipped stages; "repro_verify"
    // is a new stage for this side-table (the DB column is a plain text field, no
    // enum constraint). The already-merged queries.ts is intentionally NOT
    // modified here, so the new stage value is cast at the call site. When a
    // follow-up widens GateOutcomeRow["stage"] this cast can drop.
    await recordGateOutcome(reviewId, {
      findingId: row.findingId,
      stage: REPRO_VERIFY_STAGE as "patch_verify",
      verdict: row.verdict,
      evidence: row.evidence,
      modelId: null,
    });
  };
}

// Idempotency probe wiring (FIX 6): true iff a review_gate_outcomes row already
// exists for (reviewId, findingId, stage). Read-only; used by both the dry-run
// plan and the --record path so a re-run never double-writes.
async function realGateExists(): Promise<
  (reviewId: string, findingId: string, stage: string) => Promise<boolean>
> {
  const { db } = await import("@/db");
  const { reviewGateOutcomes } = await import("@/db/schema");
  const { and, eq } = await import("drizzle-orm");
  return async (reviewId, findingId, stage) => {
    const existing = await db
      .select({ id: reviewGateOutcomes.id })
      .from(reviewGateOutcomes)
      .where(
        and(
          eq(reviewGateOutcomes.reviewId, reviewId),
          eq(reviewGateOutcomes.findingId, findingId),
          eq(reviewGateOutcomes.stage, stage),
        ),
      )
      .limit(1);
    return existing.length > 0;
  };
}

// ────────────────────────────────────────────────────────────────────────
// CLI entrypoint
// ────────────────────────────────────────────────────────────────────────

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const { get, has } = parseArgs(argv);
  const phase = get("--phase");

  if (phase === "fetch") {
    // Secrets live here (DATABASE_URL + ANTHROPIC_API_KEY + GITHUB_TOKEN). This
    // is the ONLY phase that loads the env file.
    loadDotenv({ path: ".env.local", quiet: true });
    const limit = clampLimit(get("--limit"));
    const repoRaw = get("--repo");
    const repo = repoRaw !== null && repoRaw.trim().length > 0 ? repoRaw.trim() : null;
    await runFetchPhase({
      limit,
      repo,
      outPath: get("--out") ?? DEFAULT_SPECS_PATH,
    });
    return;
  }

  if (phase === "exec") {
    // NO loadDotenv here — the exec phase must stay secretless. runExecPhase
    // asserts that before doing anything.
    await runExecPhase({
      inPath: get("--in") ?? DEFAULT_SPECS_PATH,
      outPath: get("--out") ?? DEFAULT_VERDICTS_PATH,
    });
    return;
  }

  if (phase === "record") {
    loadDotenv({ path: ".env.local", quiet: true });
    await runRecordPhase({
      inPath: get("--in") ?? DEFAULT_VERDICTS_PATH,
      record: has("--record"),
    });
    return;
  }

  throw new Error(
    `[repro-verify-batch] unknown or missing --phase (got ${JSON.stringify(phase)}); ` +
      `expected one of fetch | exec | record`,
  );
}

function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_FETCH_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_FETCH_LIMIT;
  return n;
}

// Guard the main() call so importing this module (in tests) does NOT execute it.
const isDirectRun = (process.argv[1] ?? "").includes("repro-verify-batch");
if (isDirectRun) {
  void main().catch((err) => {
    console.error("[repro-verify-batch] fatal:", err);
    process.exit(1);
  });
}
