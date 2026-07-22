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
//     - FIRST asserts the exec environment contains ONLY known-non-secret vars
//       (assertNoSecretsInEnv — an ALLOWLIST-ONLY guard, fail CLOSED: any var
//       not in ALLOWED_EXEC_ENV is refused, so every current AND future secret
//       is rejected by default). This proves the workflow's per-step env
//       separation held. THEN requires the ANTFLEET_REPRO_SANDBOX marker the
//       trusted container step sets, refusing to run on a bare host.
//     - Then flips ANTFLEET_REPRO_EXEC on FOR THIS PROCESS ONLY, reads the specs
//       file, and runs each through runReproVerifier in OFFLINE mode (clone from
//       the pre-materialised mirror — no network). The workflow additionally
//       wraps this step with an egress lockdown so the model repro has no
//       network at all. Writes verdicts to a JSON file. No DB, no provider, no
//       secret.
//
//   record (WITH the DB secret, but WRITE-gated + idempotent)
//     - reads the verdicts file and, only when --record is passed, writes one
//       review_gate_outcomes row per verdict (stage "repro_verify"). Idempotency
//       is enforced by the DB: an ON CONFLICT DO NOTHING against the partial
//       unique index review_gate_outcomes_repro_verify_uniq (migration 0053) so
//       a concurrent re-run cannot double-write. Default is a dry-run that prints
//       what it WOULD write (consulting a read-only existence probe) and touches
//       nothing.
//
// The flag stays OFF in the app. Nothing here flips it except the exec phase's
// own process and the workflow's exec step. Run with:
//   tsx scripts/repro-verify-batch.ts --phase <fetch|exec|record> [flags]

import { config as loadDotenv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import type { Finding } from "@/lib/review-types";
import type { ReproTestSuggestion } from "@antfleet/cli/types";
import type { PatchVerifyOutcome } from "@/lib/patch-verifier";

// ── ALLOWLIST-ONLY exec-env guard (FIX A). The exec phase runs
// attacker-influenced (model-generated) code, so its env is a hard security
// boundary. The prior design (explicit forbidden-list + secret-shaped suffix
// pattern MINUS broad prefix allowlists) was LEAKY by construction: an
// ANTFLEET_/RUNNER_/NODE_/npm_config_ prefix waved through anything, and a
// secret whose name did not end in a known suffix (NODE_AUTH_TOKEN,
// npm_config_authToken, ANTFLEET_ALERT_WEBHOOK_URL, RUNNER_ADMIN_SECRET,
// ROAST_IP_SALT, a future ANTFLEET_FUTURE_TOKEN) sailed through.
//
// This replaces it with an EXACT allowlist that is fail-closed by construction:
// the exec phase may ONLY see these known-non-secret vars. ANY other non-empty
// var — including every current and FUTURE secret — is refused with NO code
// change required, because the default is "reject". There are deliberately NO
// prefix wildcards for any secret-capable family (ANTFLEET_/RUNNER_/npm_config_
// etc.): each permitted metadata name is enumerated in full.
const ALLOWED_EXEC_ENV = new Set<string>([
  // The exec phase deliberately sets this ON for its own process, and the
  // Part-3 container step sets the sandbox marker (FIX H) — both are
  // non-secret booleans and must survive the guard.
  "ANTFLEET_REPRO_EXEC",
  "ANTFLEET_REPRO_SANDBOX",
  // Common shell / toolchain / locale vars (non-secret).
  "PATH",
  "HOME",
  "CI",
  "PWD",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "TMPDIR",
  "NODE_ENV",
  // GitHub Actions metadata — the NON-SECRET names the runner exports. Note the
  // secret-bearing GITHUB_TOKEN is deliberately ABSENT: it is a credential, so
  // it must be rejected if it ever leaks into the exec step.
  "GITHUB_ACTIONS",
  "GITHUB_WORKFLOW",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_NUMBER",
  "GITHUB_JOB",
  "GITHUB_ACTION",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKSPACE",
  "GITHUB_EVENT_NAME",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  // GitHub Actions runner metadata — NON-SECRET names only (no RUNNER_*
  // wildcard, so a RUNNER_ADMIN_SECRET is rejected).
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_NAME",
  "RUNNER_TEMP",
  "RUNNER_WORKSPACE",
  "RUNNER_TOOL_CACHE",
]);

// The env marker the trusted Part-3 container step sets to prove the exec phase
// is running inside the disposable `--network none` sandbox (FIX H). Read by
// runExecPhase's hard guard; also allowlisted above so it survives FIX A.
const REPRO_SANDBOX_MARKER = "ANTFLEET_REPRO_SANDBOX";

const DEFAULT_FETCH_LIMIT = 5;
const DEFAULT_SPECS_PATH = "repro-specs.json";
const DEFAULT_VERDICTS_PATH = "repro-verdicts.json";

// The mkdtemp basename prefix realCreateMirror uses for every disposable bare
// mirror: `antfleet-mirror-<uuid>-<6 random chars>` under os.tmpdir(). Kept as a
// shared constant so isOwnedMirrorDir's ownership regex (FIX 2) and the mkdtemp
// template can never drift apart.
const MIRROR_BASENAME_PREFIX = "antfleet-mirror-";

// The stage value written to review_gate_outcomes for this side-table. The DB
// column is plain free-text (no enum). Kept as a shared constant so the writer,
// the read-only existence probe, and the partial-unique-index predicate
// (migration 0053) all agree on the exact string.
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

// The valid detector domain — the RunnerKind values patch-verifier/repro-verifier
// emit (`pnpm|npm|go|pytest|none`). parseVerdicts (FIX 4) validates every record's
// detector against this, and additionally requires a `verified` record to name a
// REAL runner (the "none" sentinel is only ever an inconclusive/no-runner marker,
// never a proof). Kept in sync with RunnerKind in lib/patch-verifier.ts.
const REAL_RUNNER_DETECTORS = new Set(["pnpm", "npm", "go", "pytest"]);
const DETECTOR_VALUES = new Set([...REAL_RUNNER_DETECTORS, "none"]);
// The closed InconclusiveReason union (patch-verifier.ts). A verdict record's
// inconclusiveReason must be null or one of these — a forged/garbage reason
// string is rejected so it can never be persisted as a gate-outcome tag.
const INCONCLUSIVE_REASON_VALUES = new Set<string>([
  "no_runner",
  "no_poc",
  "test_timeout",
  "poc_timeout",
  "adapter_refused",
  "evidence_unreadable",
  "no_repo_url",
  "invalid_input",
  "setup_failed",
  "exception",
  "repro_exec_disabled",
  "no_repro",
  "repro_not_reproducing",
  "repro_timeout",
  "unsafe_repro_write",
  "patch_apply_failed",
  "abnormal_exit",
  "deps_unavailable",
]);

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

// A var counts as "present" only when it is a non-empty string — an
// exported-but-empty var is harmless. Module-scope so the allowlist guard and
// any future caller share one definition (and so oxlint's
// consistent-function-scoping stays happy; FIX I).
function isEnvValuePresent(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

// HARD, ALLOWLIST-ONLY fail-closed guard for the exec phase (FIX A). Throws if
// ANY non-empty var in the environment is NOT in ALLOWED_EXEC_ENV. Because the
// default is "reject", every secret — including ones added AFTER this code was
// written (a new API key, a new NODE_AUTH_TOKEN, a future ANTFLEET_*_TOKEN) — is
// refused with no code change. This is the proof that the workflow's exec step
// really did run without secrets: if the per-step env separation ever regresses
// and a credential leaks in, this stops the run BEFORE a single line of
// model-generated code executes. The thrown error NAMES the offending var(s).
// Exported for tests.
export function assertNoSecretsInEnv(env: Record<string, string | undefined> = process.env): void {
  const disallowed: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isEnvValuePresent(value)) continue; // empty/unset → harmless
    if (ALLOWED_EXEC_ENV.has(key)) continue; // enumerated non-secret
    disallowed.push(key);
  }

  if (disallowed.length > 0) {
    disallowed.sort();
    throw new Error(
      `[repro-verify-batch] REFUSING to execute model-generated code: disallowed var(s) present ` +
        `in the exec environment: ${disallowed.join(", ")}. The exec phase must run with ONLY the ` +
        `known-non-secret vars in ALLOWED_EXEC_ENV (allowlist-only, fail closed) — this proves the ` +
        `CI env separation held. If a var is genuinely non-secret and legitimately needed, add its ` +
        `EXACT name to ALLOWED_EXEC_ENV; never add a secret to the exec step.`,
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

// Witnessability provenance (2b decision, condition 3). The public Actions
// run-log URL proves a third party CAN inspect the execution, but a URL is not
// integrity — a receipt must also pin WHAT ran and produced the verdict. We
// capture the run coordinates + the workflow-file commit SHA from the Actions
// environment; the verdict digest below binds the recorded verdict to its
// content. Returns null off Actions (local dry-runs), so the record phase stays
// runnable without a workflow context.
export type RunProvenance = {
  runId: string;
  runAttempt: string;
  runUrl: string;
  workflowSha: string;
  workflowRef: string;
} | null;

export function readRunProvenance(
  env: Record<string, string | undefined> = process.env,
): RunProvenance {
  const runId = env["GITHUB_RUN_ID"];
  if (runId === undefined || runId.length === 0) return null;
  const server = env["GITHUB_SERVER_URL"] ?? "https://github.com";
  const repo = env["GITHUB_REPOSITORY"] ?? "";
  const attempt = env["GITHUB_RUN_ATTEMPT"] ?? "1";
  return {
    runId,
    runAttempt: attempt,
    runUrl:
      repo.length > 0 ? `${server}/${repo}/actions/runs/${runId}/attempts/${attempt}` : server,
    // GITHUB_WORKFLOW_SHA pins the workflow-file commit; fall back to the
    // checkout SHA. This is the "workflow-file SHA" the decision requires.
    workflowSha: env["GITHUB_WORKFLOW_SHA"] ?? env["GITHUB_SHA"] ?? "",
    workflowRef: env["GITHUB_WORKFLOW_REF"] ?? "",
  };
}

// Content digest binding the recorded verdict to exactly what was decided.
// A witness can recompute this from the evidence and compare — the "verdict
// digest" of condition 3.
export function computeVerdictDigest(v: VerdictRecord): string {
  const material = JSON.stringify({
    reviewId: v.reviewId,
    findingId: v.findingId,
    verdict: v.verdict,
    sha: v.sha,
    reproCmd: v.reproCmd,
    reproPreExitCode: v.reproPreExitCode,
    reproPostExitCode: v.reproPostExitCode,
    testExitCode: v.testExitCode,
    specDigest: v.specDigest,
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
  // candidate rows within the recency window. `truncated` is an EXPLICIT flag
  // (FIX F): true iff the eligible-row scan hit the ceiling and older candidates
  // were dropped. It is computed from the JOINED finding-row count (not the
  // distinct-review count), so N findings across fewer reviews still surface the
  // truncation that a review-count check would miss.
  loadCandidates: (
    repo: string | null,
    scanCeiling: number,
  ) => Promise<{ rows: CandidateRow[]; scanned: number; truncated: boolean; sinceIso: string }>;
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
  // exec phase can clone OFFLINE. `prNumber` lets the prod impl pin via the
  // ADVERTISED refs/pull/<n>/head ref + verify it resolves to `sha` (FIX D) —
  // reliable even for a hidden PR SHA. Returns the mirror dir. Injectable so
  // tests never touch git / the network.
  createMirror: (repoUrl: string, sha: string, prNumber: number) => Promise<string>;
};

export async function runFetchPhase(opts: FetchPhaseOptions): Promise<ReproSpec[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const deps = opts.deps ?? (await realFetchDeps());

  const { rows, scanned, truncated, sinceIso } = await deps.loadCandidates(
    opts.repo,
    CANDIDATE_SCAN_CEILING,
  );
  // Total ELIGIBLE findings across the loaded candidate rows (consensus + a
  // suggested patch — the SQL already filtered to these). Drives the --limit
  // exhaustion log below (FIX F).
  const totalEligibleFindings = rows.reduce((n, r) => n + r.findingStatuses.length, 0);
  log(
    `[fetch] window since ${sinceIso}; scanned ${scanned} recent review(s); ` +
      `${rows.length} carry a consensus finding with a suggested patch ` +
      `(${totalEligibleFindings} eligible finding(s))` +
      (opts.repo !== null ? ` (repo filter ${opts.repo})` : ""),
  );
  // TRUNCATION (FIX F): loadCandidates now reports `truncated` explicitly from
  // the JOINED finding-row count, not the distinct-review count — so N findings
  // across fewer reviews still surfaces here (the old `scanned >= ceiling`
  // review-count check silently missed that case).
  if (truncated) {
    log(
      `[fetch] eligible-candidate scan hit the ${CANDIDATE_SCAN_CEILING}-row ceiling — older ` +
        `candidates were TRUNCATED; narrow with --repo or shorten the window to reach them`,
    );
  }

  const specs: ReproSpec[] = [];
  let attempts = 0;
  let dropped = 0;
  let findingsConsidered = 0;
  let limitHit = false;
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
      if (attempts >= opts.limit) {
        limitHit = true;
        break outer;
      }
      findingsConsidered++;

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
      // No evidence entry with a REAL (non-empty) path → the verifier can't
      // anchor a repro. extractAgreed already dropped empty-path entries (FIX C),
      // so an all-`[{}]` finding lands here as length 0. Drop at pairing time
      // rather than spend a generation call (does NOT consume the cap).
      if (agreedFinding.evidence.length === 0) {
        noteSkip(
          "no-evidence",
          status.findingId,
          `agreed finding at index ${status.findingIndex} has no evidence entry with a real path`,
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
      // avoids a clone for a finding the model declined. Thread prNumber (FIX D)
      // so the mirror can pin the reviewed SHA via the ADVERTISED refs/pull ref
      // (a hidden/unadvertised PR SHA is not fetchable as a raw object under git
      // protocol v0).
      const repoUrl = `https://github.com/${row.owner}/${row.repo}.git`;
      let mirrorDir: string;
      try {
        mirrorDir = await deps.createMirror(repoUrl, row.commitSha, row.prNumber);
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

  // --limit EXHAUSTION (FIX F): if we broke on the cap and there are eligible
  // findings we never reached, say so explicitly — otherwise a caller cannot
  // tell an empty run apart from a capped one.
  if (limitHit && findingsConsidered < totalEligibleFindings) {
    log(
      `[fetch] --limit (${opts.limit}) reached with ${
        totalEligibleFindings - findingsConsidered
      } eligible finding(s) still unprocessed — raise --limit or narrow --repo to reach them`,
    );
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
  // Injectable mirror-teardown seam (FIX E). Production omits it and binds a real
  // recursive rmdir; tests inject a spy to assert each spec's mirror is removed.
  removeMirror?: (mirrorDir: string) => Promise<void>;
  log?: (msg: string) => void;
};

export async function runExecPhase(opts: ExecPhaseOptions): Promise<VerdictRecord[]> {
  const log = opts.log ?? ((m: string) => console.log(m));

  // NOTE (Build 2b-2 redesign): the orchestrator now runs on the TRUSTED runner,
  // not inside a container — so its own process.env legitimately carries the
  // runner's (non-secret) CI metadata and an allowlist-only check on it no longer
  // makes sense. The secret boundary moved DOWN to each command: makeContainerExec
  // passes `--env-file /dev/null` + only the verifier's minimal env into every
  // `--network none` container, and assertContainerEnvClean fails closed if a
  // secret-shaped var ever reaches an untrusted command. The exec JOB itself
  // carries no secrets (permissions:{}, persist-credentials:false in the workflow).
  //
  // HARD GUARD: this phase spins up docker containers to execute model-generated
  // code. Refuse to run unless the workflow's exec job set ANTFLEET_REPRO_SANDBOX,
  // so `--phase exec` cannot be run casually on a dev laptop. Reads process.env
  // DIRECTLY and fails CLOSED — no injectable override around the guard.
  if (!isEnvValuePresent(process.env[REPRO_SANDBOX_MARKER])) {
    throw new Error(
      `[repro-verify-batch] REFUSING to run the exec phase: ${REPRO_SANDBOX_MARKER} is not set. ` +
        `This phase executes model-generated code in per-command --network none containers and is ` +
        `meant to run in the workflow's exec job (which sets that marker + provides docker). Do NOT ` +
        `run it on a bare host.`,
    );
  }

  // Preserve the caller's ANTFLEET_REPRO_EXEC so the whole flip is restored on
  // EVERY exit path (FIX I) — this process is otherwise long-lived (tests import
  // it) and leaving the app flag ON would leak into unrelated code.
  const priorReproExec = process.env["ANTFLEET_REPRO_EXEC"];
  // Flip the exec gate ON for THIS PROCESS ONLY. This is the sole place the app
  // flag is enabled outside the workflow's exec step; runReproVerifier is a
  // no-op (inconclusive repro_exec_disabled) without it.
  process.env["ANTFLEET_REPRO_EXEC"] = "true";

  try {
    const runVerifier = opts.runVerifier ?? (await realVerifier());
    const removeMirror = opts.removeMirror ?? realRemoveMirror;
    const specs = opts.loadSpecs
      ? await opts.loadSpecs()
      : parseSpecs(await readFile(opts.inPath, "utf8"));
    log(`[exec] loaded ${specs.length} spec(s) from ${opts.inPath}`);

    const records: VerdictRecord[] = [];
    for (const spec of specs) {
      // FIX E: the fetch phase created one disposable bare mirror per spec; tear
      // it down after this spec's verifier runs so the mirrors do not leak. The
      // read-only mount + one-mirror-per-sandbox isolation stays Part 3's
      // container job — this is just the disk-leak cleanup for the offline mirror.
      try {
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
      } finally {
        try {
          await removeMirror(spec.mirrorDir);
        } catch {
          // best effort — a leaked mirror in the disposable sandbox is reclaimed
          // when the container is torn down; never fail the batch on cleanup.
        }
      }
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
  } finally {
    // Restore the flag on ALL paths (return, throw). (FIX I)
    if (priorReproExec === undefined) {
      delete process.env["ANTFLEET_REPRO_EXEC"];
    } else {
      process.env["ANTFLEET_REPRO_EXEC"] = priorReproExec;
    }
  }
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
  // is NOT called without --record. Returns TRUE iff the DB actually INSERTED a
  // row (FIX 6a): an ON CONFLICT DO NOTHING no-op returns false so a concurrent
  // re-run that races past the app-level existence pre-check does NOT over-report
  // `written`.
  writeGateOutcome?: (
    reviewId: string,
    row: { findingId: string; verdict: string; evidence: unknown },
  ) => Promise<boolean>;
  // Idempotency probe (FIX 6): true iff a review_gate_outcomes row already exists
  // for (reviewId, findingId, stage). Injectable; production binds the real
  // lookup lazily. When it returns true the row is SKIPPED (logged) rather than
  // duplicated. In dry-run this is consulted so the plan reflects reality.
  gateOutcomeExists?: (reviewId: string, findingId: string, stage: string) => Promise<boolean>;
  // Injectable verdict source, for tests. Production reads inPath.
  loadVerdicts?: () => Promise<VerdictRecord[]>;
  // Witnessability provenance embedded into each row's evidence. Production
  // omits it and reads the Actions env via readRunProvenance(); tests inject.
  // Explicit `null` records "no provenance" (a local run).
  provenance?: RunProvenance;
  log?: (msg: string) => void;
};

export async function runRecordPhase(opts: RecordPhaseOptions): Promise<number> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const provenance = opts.provenance !== undefined ? opts.provenance : readRunProvenance();
  const verdicts = opts.loadVerdicts
    ? await opts.loadVerdicts()
    : parseVerdicts(await readFile(opts.inPath, "utf8"));
  log(`[record] loaded ${verdicts.length} verdict(s) from ${opts.inPath}`);
  if (provenance !== null) {
    log(`[record] witnessability: run ${provenance.runUrl} (workflow ${provenance.workflowSha})`);
  }

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
    // This app-level pre-check keeps the log/counters accurate; the ATOMIC guard
    // is the DB constraint the writer targets with ON CONFLICT DO NOTHING (FIX
    // G), so even a concurrent run that races past this check cannot double-write.
    if (await exists(v.reviewId, v.findingId, REPRO_VERIFY_STAGE)) {
      skipped++;
      log(`[record] already recorded — skipping review=${v.reviewId} finding=${v.findingId}`);
      continue;
    }
    const inserted = await write(v.reviewId, {
      findingId: v.findingId,
      verdict: v.verdict,
      // Persist the full enriched record as evidence so the row is
      // self-describing (sha, repro/test details, exit codes, timings, digest),
      // plus witnessability provenance (run URL + workflow SHA) and a verdict
      // digest binding the row to what actually ran (2b decision, condition 3).
      evidence: { ...v, provenance, verdictDigest: computeVerdictDigest(v) },
    });
    // FIX 6a: only count a row the DB ACTUALLY inserted. ON CONFLICT DO NOTHING
    // returns false for a row a concurrent run already wrote between our
    // existence pre-check and this insert, so `written` never over-reports.
    if (inserted) {
      written++;
    } else {
      skipped++;
      log(
        `[record] no-op (already recorded by a concurrent run) — review=${v.reviewId} ` +
          `finding=${v.findingId}`,
      );
    }
  }
  log(
    `[record] wrote ${written} review_gate_outcomes row(s) (stage=${REPRO_VERIFY_STAGE}); ` +
      `skipped ${skipped} already-recorded`,
  );
  return written;
}

// ────────────────────────────────────────────────────────────────────────
// Parsing helpers (exported for tests) — JSON readers that fail LOUD on a
// malformed artifact so a corrupt file never silently produces an empty or wrong
// run, or lets a null spec through to be dereferenced downstream.
// ────────────────────────────────────────────────────────────────────────

// Shared, module-scope shape predicates (FIX B + FIX I — hoisted out of the
// parsers so both share one definition and oxlint's consistent-function-scoping
// stays satisfied).
function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}
function isStringOrNull(x: unknown): x is string | null {
  return x === null || typeof x === "string";
}
function isIntegerGteZero(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}
// A process exit code: null (killed / no clean exit) or an integer in [0,255].
// Rejects negative / fractional values a forged verdict artifact might carry —
// notably a negative `reproPostExitCode` that would otherwise satisfy the
// verified proof invariant's `!== 0` check.
function isExitCodeOrNull(x: unknown): x is number | null {
  return x === null || (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 255);
}
// A wall-clock duration in ms: null or a finite number >= 0 (no negatives).
function isNonNegNumberOrNull(x: unknown): x is number | null {
  return x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
}

// STRICT (FIX 3): validate EVERY field of EVERY element, not just "is an array"
// and not just a subset. The exec exception-recovery path dereferences
// spec.reviewId / spec.repro.cmd / spec.repro.modelId / etc., and computeSpecDigest
// (re-run downstream) reads spec.repro.file, so a null / {} / missing-field / wrong-
// typed element must be rejected here rather than blow up or misbehave mid-batch.
// The shape mirrors exactly what runFetchPhase emits: non-empty reviewId/findingId/
// sha/patch/mirrorDir/specDigest strings, an integer findingIndex >= 0, a string
// repoUrl, and a `repro` object with cmd (string|null), file ({path,contents} or
// null), rationale (string|null), and modelId (string|null).
export function parseSpecs(json: string): ReproSpec[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("repro-specs file did not contain a JSON array");
  parsed.forEach((rec, i) => {
    if (rec === null || typeof rec !== "object") {
      throw new Error(`repro-specs[${i}] is not an object`);
    }
    const r = rec as Record<string, unknown>;
    for (const field of [
      "reviewId",
      "findingId",
      "sha",
      "patch",
      "mirrorDir",
      "specDigest",
    ] as const) {
      if (!isNonEmptyString(r[field])) {
        throw new Error(`repro-specs[${i}].${field} must be a non-empty string`);
      }
    }
    if (!isIntegerGteZero(r["findingIndex"])) {
      throw new Error(`repro-specs[${i}].findingIndex must be an integer >= 0`);
    }
    if (typeof r["repoUrl"] !== "string") {
      throw new Error(`repro-specs[${i}].repoUrl must be a string`);
    }
    const repro = r["repro"];
    if (repro === null || typeof repro !== "object") {
      throw new Error(`repro-specs[${i}].repro must be an object`);
    }
    const rp = repro as Record<string, unknown>;
    if (!isStringOrNull(rp["cmd"])) {
      throw new Error(`repro-specs[${i}].repro.cmd must be a string or null`);
    }
    if (!isStringOrNull(rp["rationale"])) {
      throw new Error(`repro-specs[${i}].repro.rationale must be a string or null`);
    }
    if (!isStringOrNull(rp["modelId"])) {
      throw new Error(`repro-specs[${i}].repro.modelId must be a string or null`);
    }
    // file: either explicit null (the model wrote no file — a bare-cmd repro) or
    // a { path: string, contents: string } object. A half-formed file object is
    // rejected loudly.
    const file = rp["file"];
    if (file !== null) {
      if (typeof file !== "object") {
        throw new Error(`repro-specs[${i}].repro.file must be an object or null`);
      }
      const f = file as Record<string, unknown>;
      if (typeof f["path"] !== "string" || typeof f["contents"] !== "string") {
        throw new Error(
          `repro-specs[${i}].repro.file must have string path and contents (or be null)`,
        );
      }
    }
  });
  return parsed as ReproSpec[];
}

// STRICT (FIX B): validate EACH record's shape, not just "is an array". A
// corrupt / partially-written verdicts file — or a FORGED `verified` with null
// proofs — is rejected loudly rather than silently persisted. Beyond the field
// types, ENFORCE the proof invariant: a verdict:"verified" record MUST carry a
// concrete positive proof (a real detector, a passing test, a reproducing
// pre-patch run, a concrete non-zero post-patch exit, and no inconclusiveReason)
// — the exact shape runReproVerifier only ever emits for a genuine proof.
export function parseVerdicts(json: string): VerdictRecord[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("repro-verdicts file did not contain a JSON array");
  parsed.forEach((rec, i) => {
    if (rec === null || typeof rec !== "object") {
      throw new Error(`repro-verdicts[${i}] is not an object`);
    }
    const r = rec as Record<string, unknown>;
    if (!isNonEmptyString(r["reviewId"])) {
      throw new Error(`repro-verdicts[${i}].reviewId must be a non-empty string`);
    }
    if (!isNonEmptyString(r["findingId"])) {
      throw new Error(`repro-verdicts[${i}].findingId must be a non-empty string`);
    }
    if (typeof r["verdict"] !== "string" || !VERDICT_VALUES.has(r["verdict"])) {
      throw new Error(
        `repro-verdicts[${i}].verdict must be one of verified|regressed|inconclusive`,
      );
    }
    if (
      r["inconclusiveReason"] !== null &&
      !(
        typeof r["inconclusiveReason"] === "string" &&
        INCONCLUSIVE_REASON_VALUES.has(r["inconclusiveReason"])
      )
    ) {
      throw new Error(
        `repro-verdicts[${i}].inconclusiveReason must be null or a known InconclusiveReason`,
      );
    }
    if (!isNonEmptyString(r["sha"])) {
      throw new Error(`repro-verdicts[${i}].sha must be a non-empty string`);
    }
    if (!isStringOrNull(r["reproCmd"])) {
      throw new Error(`repro-verdicts[${i}].reproCmd must be a string or null`);
    }
    if (typeof r["detector"] !== "string" || !DETECTOR_VALUES.has(r["detector"])) {
      throw new Error(`repro-verdicts[${i}].detector must be one of pnpm|npm|go|pytest|none`);
    }
    for (const field of ["testExitCode", "reproPreExitCode", "reproPostExitCode"] as const) {
      if (!isExitCodeOrNull(r[field])) {
        throw new Error(
          `repro-verdicts[${i}].${field} must be null or an integer exit code in [0,255]`,
        );
      }
    }
    for (const field of ["testMs", "reproPreMs", "reproPostMs"] as const) {
      if (!isNonNegNumberOrNull(r[field])) {
        throw new Error(`repro-verdicts[${i}].${field} must be null or a number >= 0`);
      }
    }
    if (typeof r["totalMs"] !== "number" || !Number.isFinite(r["totalMs"]) || r["totalMs"] < 0) {
      throw new Error(`repro-verdicts[${i}].totalMs must be a number >= 0`);
    }
    if (!isStringOrNull(r["modelId"])) {
      throw new Error(`repro-verdicts[${i}].modelId must be a string or null`);
    }
    if (!isNonEmptyString(r["specDigest"])) {
      throw new Error(`repro-verdicts[${i}].specDigest must be a non-empty string`);
    }
    if (typeof r["notes"] !== "string") {
      throw new Error(`repro-verdicts[${i}].notes must be a string`);
    }
    // PROOF INVARIANT: a `verified` record must carry a genuine proof, or it is a
    // forgery and we reject the whole file. runReproVerifier only ever emits
    // verified with detector!=="none", testExitCode===0, reproPreExitCode===0, a
    // concrete nonzero integer reproPostExitCode, and inconclusiveReason===null.
    if (r["verdict"] === "verified") {
      const detector = r["detector"];
      const testExit = r["testExitCode"];
      const pre = r["reproPreExitCode"];
      const post = r["reproPostExitCode"];
      // detector must name a REAL runner (FIX 4) — "none" (or any non-runner value)
      // is only ever an inconclusive marker, never a proof. This rejects a forged
      // verified with detector:"" / "bogus" / "none" in addition to the exit-code
      // proof invariant below.
      const proven =
        REAL_RUNNER_DETECTORS.has(detector) &&
        testExit === 0 &&
        pre === 0 &&
        typeof post === "number" &&
        Number.isInteger(post) &&
        post !== 0 &&
        r["inconclusiveReason"] === null;
      if (!proven) {
        throw new Error(
          `repro-verdicts[${i}] claims verdict:"verified" without a valid proof ` +
            `(need a real runner detector ∈ pnpm|npm|go|pytest, testExitCode===0, ` +
            `reproPreExitCode===0, a concrete non-zero reproPostExitCode, and ` +
            `inconclusiveReason===null); refusing a forged verified record`,
        );
      }
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
      // EFFECTIVE-PATH FILTER (FIX C): keep ONLY evidence entries that carry a
      // real, non-empty `path`. A malformed `{}` entry maps to path:"" and would
      // otherwise inflate the array length past the no-evidence guard (which the
      // verifier needs to anchor a repro). Dropping empty-path entries here makes
      // the pairing-time `evidence.length === 0` check reject a finding that has
      // zero usable evidence paths, and keeps reconstructFinding fed only real
      // paths.
      evidence: evidence
        .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
        .map((e) => ({
          path: typeof e["path"] === "string" ? e["path"] : "",
          startLine: typeof e["startLine"] === "number" ? e["startLine"] : null,
          endLine: typeof e["endLine"] === "number" ? e["endLine"] : null,
        }))
        // EFFECTIVE-PATH (FIX 6b): reject whitespace-only paths too — a `"   "`
        // path is not a usable anchor, so trim before the emptiness test.
        .filter((e) => e.path.trim().length > 0),
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
      // Fetch ceiling+1 JOINED rows (FIX F): the cap bounds finding rows, but the
      // caller counts reviews, so we detect truncation by whether a (ceiling+1)th
      // ELIGIBLE finding row exists — then slice back to the ceiling. This
      // surfaces the "N findings across fewer reviews hit the cap" case the old
      // review-count check silently dropped. `.orderBy(createdAt DESC, reviewId,
      // finding_index)` makes the cut deterministic.
      const rawJoined = await db
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
        .orderBy(
          sql`${reviews.createdAt} DESC`,
          sql`${reviews.reviewId}`,
          sql`${findingStatus.findingIndex}`,
        )
        .limit(scanCeiling + 1);

      const truncated = rawJoined.length > scanCeiling;
      const joined = truncated ? rawJoined.slice(0, scanCeiling) : rawJoined;

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
        truncated,
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
    createMirror: async (repoUrl, sha, prNumber) => realCreateMirror(repoUrl, sha, prNumber),
  };
}

// Materialise a disposable BARE git mirror of repoUrl pinned to `sha`, so the
// exec phase can clone OFFLINE with NO network. Steps:
//   1. mkdtemp a fresh dir under tmpdir()/antfleet-mirror-<uuid> (per-mirror,
//      disposable; Part 3 mounts it read-only).
//   2. `git clone --bare <repoUrl> <dir>` — the full mirror.
//   3. PIN the reviewed SHA under a durable ref refs/pinned/<sha> so an offline
//      raw-SHA fetch resolves under any protocol version and the object survives
//      GC. There are TWO ways to pin (FIX D):
//        a) prNumber > 0 → fetch the ADVERTISED PR ref
//           `refs/pull/<n>/head:refs/pinned/<sha>` then VERIFY
//           `git rev-parse --verify refs/pinned/<sha>^{commit}` equals `<sha>`
//           (`^{commit}` peels to and prints the COMMIT object id — a bare
//           `rev-parse -- <ref>` prints the literal ref text, never the SHA). A
//           PR head SHA is
//           frequently HIDDEN (unadvertised) on the branch tips, so a direct
//           raw-SHA fetch fails under git protocol v0; the PR ref is always
//           advertised. If the fetched head does not match the reviewed SHA
//           (e.g. the PR was force-pushed after review) we FAIL the spec with a
//           clear reason rather than pin the wrong commit.
//        b) prNumber <= 0 (non-PR review / ad-hoc replay) → fall back to the raw
//           `<sha>:refs/pinned/<sha>` fetch (works when the SHA is advertised).
// repoUrl + sha are validated (isSafeRepoUrl / isSafeSha) so nothing model- or
// user-controlled reaches git argv unchecked; the `--` separators are the
// second layer. On ANY failure the partially-created temp dir is removed so a
// failed clone/fetch/verify does not leak (FIX E).
// The argv-direct git runner seam. `execFile`-style: (file, args) with NO shell,
// resolving to the captured stdout/stderr. realCreateMirror binds the real
// promisified child_process.execFile; pinReproMirror takes it as a param so a
// test can assert the EXACT argv without spawning git.
export type GitRun = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

// Pin the reviewed SHA under refs/pinned/<sha> inside an already-cloned bare
// mirror `dir`, and (for a PR) VERIFY the advertised head resolves to that SHA
// (FIX D + FIX 1). Extracted + exported so a test can inject `run` and assert the
// exact rev-parse argv. Throws (with a clear reason) on a PR head/SHA mismatch.
//   - prNumber > 0: fetch refs/pull/<n>/head into the pin ref, then
//     `git -C <dir> rev-parse --verify refs/pinned/<sha>^{commit}` — `^{commit}`
//     peels the ref to its COMMIT object id and PRINTS the 40-char SHA (a bare
//     `rev-parse -- <ref>` prints the literal ref text, never the SHA, so the
//     `=== sha` check would ALWAYS fail and turn every PR spec into a mirror
//     error). The `^{commit}` is inside the SAME argv element — still argv-direct
//     via execFile, no shell parsing.
//   - prNumber <= 0: pin the raw `<sha>:refs/pinned/<sha>` (advertised-SHA path).
export async function pinReproMirror(
  run: GitRun,
  dir: string,
  sha: string,
  prNumber: number,
): Promise<void> {
  const pinnedRef = `refs/pinned/${sha}`;
  if (Number.isInteger(prNumber) && prNumber > 0) {
    // Pin via the ADVERTISED PR head ref, then verify it is the reviewed SHA.
    await run("git", [
      "-C",
      dir,
      "fetch",
      "--quiet",
      "origin",
      "--",
      `refs/pull/${prNumber}/head:${pinnedRef}`,
    ]);
    const { stdout } = await run("git", [
      "-C",
      dir,
      "rev-parse",
      "--verify",
      `${pinnedRef}^{commit}`,
    ]);
    const resolved = stdout.trim();
    if (resolved !== sha) {
      throw new Error(
        `PR #${prNumber} head resolved to ${resolved || "(empty)"}, not the reviewed sha ${sha} ` +
          `(the PR may have been force-pushed after review); refusing to pin the wrong commit`,
      );
    }
  } else {
    // Non-PR review: pin the raw SHA under the durable ref (advertised-SHA path).
    await run("git", ["-C", dir, "fetch", "--quiet", "origin", "--", `${sha}:${pinnedRef}`]);
  }
}

async function realCreateMirror(repoUrl: string, sha: string, prNumber: number): Promise<string> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { isSafeRepoUrl, isSafeSha } = await import("@/lib/patch-verifier");
  const run = promisify(execFile) as GitRun;

  if (!isSafeRepoUrl(repoUrl)) throw new Error(`unsafe repoUrl for mirror: ${repoUrl}`);
  if (!isSafeSha(sha)) throw new Error(`unsafe sha for mirror: ${sha}`);

  // Basename prefix is the SHARED constant isOwnedMirrorDir matches on (FIX 2) —
  // they must never drift. mkdtemp appends 6 random chars, so the final basename
  // is `antfleet-mirror-<uuid>-<6 chars>`.
  const dir = await mkdtemp(join(tmpdir(), `${MIRROR_BASENAME_PREFIX}${randomUUID()}-`));
  try {
    // Full bare mirror. `--` guards the URL from being read as a flag.
    await run("git", ["clone", "--bare", "--quiet", "--", repoUrl, dir]);
    // Pin (+ verify for a PR) via the extracted, tested helper.
    await pinReproMirror(run, dir, sha, prNumber);
    return dir;
  } catch (err) {
    // Clean up the partially-created mirror so a failed clone/fetch/verify does
    // not leak a temp dir (FIX E). Best-effort; re-throw the original error.
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // swallow — the OS reclaims /tmp eventually
    }
    throw err;
  }
}

// Exec image tag. Built locally in the workflow's exec job from
// .github/repro-exec.Dockerfile (whose FROM is digest-pinned — that is the
// supply-chain pin). Carries git + node + pnpm + python/pytest. --network none
// means a repro cannot fetch deps; repros needing network degrade to a safe
// inconclusive/regressed.
export const REPRO_EXEC_IMAGE = "antfleet-repro-exec:local";

async function realVerifier(): Promise<(spec: ReproSpec) => Promise<PatchVerifyOutcome>> {
  const { runReproVerifier, realReproVerifierIo } = await import("@/lib/repro-verifier");
  const { makeContainerExec } = await import("@/lib/repro-container-exec");
  const { isReproDepPrefetchEnabled } = await import("@/lib/daybreak-gates-env");
  // Policy lives here (batch = policy, verifier = mechanism): only when the
  // flag is ON do we build the network-enabled install container and hand it to
  // the verifier as `execInstall`. OFF → the seam is absent → JS suites with
  // missing deps stay `deps_unavailable`, exactly as before.
  const depPrefetch = isReproDepPrefetchEnabled();
  // Run each container as the runner user so files written into the mounted
  // worktree are not left root-owned (which would break runner-side cleanup).
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const gid = typeof process.getgid === "function" ? process.getgid() : undefined;
  const user = uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined;

  // OFFLINE: clone from the pre-materialised mirror the fetch phase created —
  // the exec sandbox needs NO network. runReproVerifier (the orchestrator) runs
  // HERE on the trusted runner and decides the verdict; every command it issues
  // is routed through a per-command `--network none` container (the isolation
  // boundary — see repro-container-exec.ts). The verdict is this function's
  // return value, never a file any hostile container can reach. args.finding is
  // read for NO security decision (confirmed against the module), so the minimal
  // placeholder is safe.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  return async (spec: ReproSpec) => {
    const baseIo = await realReproVerifierIo();
    // The trusted patch is written to a per-spec control dir and mounted
    // READ-ONLY into the containers, so `git apply` (run in a container) can
    // read it while hostile in-container code cannot tamper with it. Writing
    // it into the rw worktree instead would let pre-patch hostile code rewrite
    // the fix before it's applied.
    const controlDir = await mkdtemp(join(tmpdir(), "antfleet-ctl-"));
    // Both containers share the SAME mounts; they differ only in network. The
    // mirror + patch control dir are read-only; the worktree (cwd) is rw.
    const mounts = [
      { host: spec.mirrorDir, container: spec.mirrorDir, readOnly: true },
      { host: controlDir, container: controlDir, readOnly: true },
    ];
    const containerExec = makeContainerExec({
      image: REPRO_EXEC_IMAGE,
      extraMounts: mounts,
      ...(user !== undefined ? { user } : {}),
    });
    // ONLY built when the flag is on. `allowNetwork: true` is the sole
    // difference — same image, same mounts, same secret-free env. Used by the
    // verifier exclusively for the dep-prefetch install; the suite + repro
    // always go through the offline `containerExec` above.
    const installExec = depPrefetch
      ? makeContainerExec({
          image: REPRO_EXEC_IMAGE,
          extraMounts: mounts,
          allowNetwork: true,
          ...(user !== undefined ? { user } : {}),
        })
      : undefined;
    try {
      return await runReproVerifier({
        repoSource: { kind: "offline", mirrorDir: spec.mirrorDir },
        sha: spec.sha,
        patch: spec.patch,
        repro: spec.repro,
        finding: minimalFindingForVerify(),
        io: {
          ...baseIo,
          exec: containerExec,
          ...(installExec !== undefined ? { execInstall: installExec } : {}),
          // Route the patch onto the ro-mounted control dir (the default writes
          // to a runner-only sibling temp dir the container can't see).
          writeTempFile: async (contents: string) => {
            const target = join(controlDir, `patch-${randomUUID()}.diff`);
            await writeFile(target, contents, "utf8");
            return target;
          },
        },
      });
    } finally {
      await rm(controlDir, { recursive: true, force: true }).catch(() => {});
    }
  };
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

// STRICT ownership predicate for the DELETE path (FIX 2). isSafeLocalMirrorDir is
// a SHAPE gate — it returns true for `/`, `/tmp`, `/home/runner`, and any other
// absolute traversal-free POSIX path — so it must NEVER gate a recursive rm: a
// forged spec.mirrorDir could redirect the delete at an arbitrary tree. This
// returns true ONLY for a directory WE created: its parent is exactly
// os.tmpdir() AND its basename matches the EXACT mkdtemp prefix
// realCreateMirror uses (`antfleet-mirror-<uuid+random>`). resolve() first so a
// `.../antfleet-mirror-x/../../etc` traversal collapses to its real parent/base
// and is refused. Pure + exported for tests.
//
// RESIDUAL (audit MEDIUM, #145): this is a PATHNAME convention, not process
// ownership — a forged spec.mirrorDir naming a DIFFERENT process's
// `antfleet-mirror-*` dir would still match. The cross-process/forged-artifact
// boundary is closed by Part 3's containment, NOT here: each exec job runs in a
// disposable `--network none` container with its OWN /tmp (no other process's
// mirrors exist in it), and the specs artifact is produced by the trusted fetch
// job. Within a single trusted run this convention is sufficient; it must not be
// relied on as the sole isolation outside that container.
export function isOwnedMirrorDir(dir: string): boolean {
  if (typeof dir !== "string" || dir.length === 0) return false;
  const resolved = resolvePath(dir);
  if (dirname(resolved) !== tmpdir()) return false;
  const base = basename(resolved);
  return new RegExp(`^${MIRROR_BASENAME_PREFIX}[A-Za-z0-9_-]+$`).test(base);
}

// Remove a per-spec disposable bare mirror after its verifier run (FIX E). The
// dir is our own (fetch-phase mkdtemp under tmpdir()); gate the recursive rm on
// the STRICT ownership predicate (FIX 2) — NOT the shape-only isSafeLocalMirrorDir,
// which waves through `/`, `/tmp`, `/home/runner`. A forged spec that points
// teardown at anything we did not create is REFUSED (warn + skip), so the
// teardown can only ever delete one of our own tmp mirrors. Recursive + force so
// a partially-cloned mirror is still cleaned; best-effort at the call site (never
// fails the batch). Exported so the teardown's ownership gate can be tested
// end-to-end against a real tmp dir.
export async function realRemoveMirror(mirrorDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  if (!isOwnedMirrorDir(mirrorDir)) {
    console.warn(
      `[exec] refusing to remove mirror dir we do not own (skipping teardown): ${mirrorDir}`,
    );
    return;
  }
  await rm(mirrorDir, { recursive: true, force: true });
}

async function realGateWriter(): Promise<
  (
    reviewId: string,
    row: { findingId: string; verdict: string; evidence: unknown },
  ) => Promise<boolean>
> {
  const { db } = await import("@/db");
  const { reviewGateOutcomes } = await import("@/db/schema");
  const { sql } = await import("drizzle-orm");
  return async (reviewId, row) => {
    // ATOMIC IDEMPOTENT WRITE (FIX G): insert directly with ON CONFLICT DO
    // NOTHING against the partial unique index
    // review_gate_outcomes_repro_verify_uniq (review_id, finding_id) WHERE
    // stage='repro_verify' (migration 0053). This replaces the racy
    // check-then-insert: two concurrent record runs can no longer both write. We
    // bypass queries.recordGateOutcome (kept unmodified) because that helper does
    // a bare insert with no conflict target; the "repro_verify" stage is a plain
    // text value (the column has no enum) so no cast is needed here.
    const inserted = await db
      .insert(reviewGateOutcomes)
      .values({
        reviewId,
        findingId: row.findingId,
        stage: REPRO_VERIFY_STAGE,
        verdict: row.verdict,
        evidence: row.evidence,
        modelId: null,
      })
      .onConflictDoNothing({
        // The `where` here is the CONFLICT-ARBITER index predicate — drizzle emits
        // `ON CONFLICT (review_id, finding_id) WHERE stage='repro_verify' DO
        // NOTHING`, which matches the partial unique index (migration 0053).
        target: [reviewGateOutcomes.reviewId, reviewGateOutcomes.findingId],
        where: sql`${reviewGateOutcomes.stage} = 'repro_verify'`,
      })
      // RETURNING lets us tell a real INSERT from an ON CONFLICT DO NOTHING no-op
      // (FIX 6a): a conflict yields zero returned rows, so `.length > 0` is true
      // ONLY when this call actually wrote the row.
      .returning({ id: reviewGateOutcomes.id });
    return inserted.length > 0;
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
