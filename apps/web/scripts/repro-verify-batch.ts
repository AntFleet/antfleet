#!/usr/bin/env tsx
// Contained CI repro-execution batch (issue #133, Build 2b-2) — the runner side
// of the prove-the-bug verifier (lib/repro-verifier.ts).
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
//   fetch  (WITH secrets: DATABASE_URL + ANTHROPIC_API_KEY)
//     - reads candidate findings from the DB, calls the real anthropic provider
//       to GENERATE a repro spec per finding, and writes the specs to a JSON
//       file. Executes NOTHING. This is the only phase allowed near secrets and
//       the model API.
//
//   exec   (NO secrets at all — the security-critical phase)
//     - FIRST asserts no secret is present in process.env (assertNoSecretsInEnv,
//       fail CLOSED). This proves the workflow's per-step env separation held.
//     - Then flips ANTFLEET_REPRO_EXEC on FOR THIS PROCESS ONLY, reads the specs
//       file, and runs each through runReproVerifier. The workflow wraps this
//       step with an iptables egress lockdown so the model repro also has no
//       network. Writes verdicts to a JSON file. No DB, no provider, no secret.
//
//   record (WITH the DB secret, but WRITE-gated)
//     - reads the verdicts file and, only when --record is passed, writes one
//       review_gate_outcomes row per verdict (stage "repro_verify"). Default is
//       a dry-run that prints what it WOULD write and touches nothing.
//
// The flag stays OFF in the app. Nothing here flips it except the exec phase's
// own process and the workflow's exec step. Run with:
//   tsx scripts/repro-verify-batch.ts --phase <fetch|exec|record> [flags]

import { config as loadDotenv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import type { Finding } from "@/lib/review-types";
import type { ReproTestSuggestion } from "@antfleet/cli/types";
import type { PatchVerifyOutcome } from "@/lib/patch-verifier";

// ── Secrets the exec phase must NEVER see. Kept as a named constant so the
// assertion and its test reference the same list. A value counts as "present"
// only when it is a non-empty string (an exported-but-empty var is harmless).
const FORBIDDEN_EXEC_SECRETS = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "POSTGRES_URL",
] as const;

const DEFAULT_FETCH_LIMIT = 5;
const DEFAULT_SPECS_PATH = "repro-specs.json";
const DEFAULT_VERDICTS_PATH = "repro-verdicts.json";

// How far back to look for candidate findings, mirroring bench-dryrun's window.
const RECENT_DAYS = 90;
// Per-review DB probe cap; keeps the candidate scan from pulling the whole
// history when --limit is large.
const REVIEW_SCAN_LIMIT = 120;

// ── Spec shape emitted by fetch, consumed by exec. This is the ONLY thing that
// crosses the secretless boundary — deliberately just the inputs runReproVerifier
// needs, no DB rows or credentials.
export type ReproSpec = {
  reviewId: string;
  findingId: string;
  repoUrl: string;
  sha: string;
  patch: string;
  repro: ReproTestSuggestion;
};

// ── Verdict shape emitted by exec, consumed by record. A flat, serialisable
// projection of the verifier outcome — enough to record + audit without carrying
// the whole PatchVerifyOutcome around.
export type VerdictRecord = {
  reviewId: string;
  findingId: string;
  verdict: PatchVerifyOutcome["verdict"];
  inconclusiveReason: PatchVerifyOutcome["inconclusiveReason"];
  reproPreExitCode: number | null;
  reproPostExitCode: number | null;
  notes: string;
};

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

// HARD, fail-closed guard for the exec phase. Throws if ANY forbidden secret is
// present and non-empty in process.env. This is the proof that the workflow's
// exec step really did run without secrets — if the env separation ever
// regresses (a secret leaks into the exec step), this stops the run BEFORE a
// single line of model-generated code executes. Exported for unit testing.
export function assertNoSecretsInEnv(env: Record<string, string | undefined> = process.env): void {
  const leaked = FORBIDDEN_EXEC_SECRETS.filter((k) => {
    const v = env[k];
    return typeof v === "string" && v.length > 0;
  });
  if (leaked.length > 0) {
    throw new Error(
      `[repro-verify-batch] REFUSING to execute model-generated code: secret(s) present in the ` +
        `exec environment: ${leaked.join(", ")}. The exec phase MUST run in a secretless step; ` +
        `this fail-closed guard proves the CI env separation held. Do NOT add secrets to the ` +
        `exec step.`,
    );
  }
}

// Project a verifier outcome onto the flat record the record phase persists.
// Pure + exported so the unit tests can assert the mapping without spawning.
export function shapeVerdictRecord(spec: ReproSpec, outcome: PatchVerifyOutcome): VerdictRecord {
  return {
    reviewId: spec.reviewId,
    findingId: spec.findingId,
    verdict: outcome.verdict,
    inconclusiveReason: outcome.inconclusiveReason,
    // reproPre/PostExitCode are OPTIONAL on PatchVerifyOutcome (an early bail
    // may omit them); normalise the missing case to null for a stable record.
    reproPreExitCode: outcome.reproPreExitCode ?? null,
    reproPostExitCode: outcome.reproPostExitCode ?? null,
    notes: outcome.notes,
  };
}

// ────────────────────────────────────────────────────────────────────────
// fetch phase — WITH secrets. Selects candidates + generates repro specs.
// Executes nothing.
// ────────────────────────────────────────────────────────────────────────

// Candidate row mirrors bench-dryrun's BenchRow: a review paired with its
// finding_status rows so we can find the ones carrying a suggested patch.
type CandidateRow = {
  reviewId: string;
  owner: string;
  repo: string;
  commitSha: string;
  prNumber: number;
  agreementDecision: unknown;
  findingStatuses: Array<{ findingId: string; suggestedPatch: string | null }>;
};

// Agreed-finding projection, copied byte-for-byte in spirit from bench-dryrun so
// the finding reconstruction is identical across the two scripts.
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
  limit: number;
  repo: string | null;
  outPath: string;
  // Injectable so the (DB + provider + github) surface can be mocked in tests.
  // Production omits it and the phase wires the real ones lazily.
  deps?: FetchDeps;
  log?: (msg: string) => void;
};

// The three async surfaces the fetch phase touches, behind one injectable seam
// (mirrors bench-dryrun's lazy dynamic imports, but hoisted to a param so tests
// stay hermetic). All are loaded lazily in the real wiring — no top-level DB
// import.
export type FetchDeps = {
  loadCandidates: (limit: number, repo: string | null) => Promise<CandidateRow[]>;
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
};

export async function runFetchPhase(opts: FetchPhaseOptions): Promise<ReproSpec[]> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const deps = opts.deps ?? (await realFetchDeps());

  const candidates = await deps.loadCandidates(opts.limit, opts.repo);
  log(`[fetch] loaded ${candidates.length} candidate review(s) with a suggested patch`);

  const specs: ReproSpec[] = [];
  let dropped = 0;
  for (const row of candidates) {
    if (specs.length >= opts.limit) break;
    const findings = extractAgreed(row.agreementDecision);
    const changedFiles = await deps.fetchChangedFiles(
      row.owner,
      row.repo,
      row.prNumber,
      row.commitSha,
    );
    for (const status of row.findingStatuses) {
      if (specs.length >= opts.limit) break;
      if (status.suggestedPatch === null) continue;
      const idx = parseFindingIndex(status.findingId);
      if (idx === null || !findingIdMatchesAgreed(idx, findings)) {
        dropped++;
        log(`[fetch] skip ${status.findingId}: id shape did not pair with an agreed finding`);
        continue;
      }
      const agreed = findings[idx];
      if (agreed === undefined) {
        dropped++;
        log(`[fetch] skip ${status.findingId}: agreed finding missing at index ${idx}`);
        continue;
      }
      const finding = reconstructFinding(agreed);
      let repro: ReproTestSuggestion | null;
      try {
        repro = await deps.generateRepro({
          reviewId: row.reviewId,
          finding,
          findingId: status.findingId,
          changedFiles,
        });
      } catch (err) {
        dropped++;
        log(
          `[fetch] skip ${status.findingId}: repro generation threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      if (repro === null) {
        dropped++;
        log(`[fetch] skip ${status.findingId}: generation returned no repro (skipped/failed)`);
        continue;
      }
      if (repro.cmd === null) {
        dropped++;
        log(
          `[fetch] skip ${status.findingId}: model declined a repro${
            repro.rationale !== null ? ` (${repro.rationale})` : ""
          }`,
        );
        continue;
      }
      specs.push({
        reviewId: row.reviewId,
        findingId: status.findingId,
        repoUrl: `https://github.com/${row.owner}/${row.repo}.git`,
        sha: row.commitSha,
        patch: status.suggestedPatch,
        repro,
      });
    }
  }

  log(`[fetch] emitted ${specs.length} runnable repro spec(s); dropped ${dropped}`);
  await writeFile(opts.outPath, JSON.stringify(specs, null, 2), "utf8");
  log(`[fetch] wrote specs to ${opts.outPath}`);
  return specs;
}

// ────────────────────────────────────────────────────────────────────────
// exec phase — NO secrets. Executes the model-generated repros. Security-critical.
// ────────────────────────────────────────────────────────────────────────

export type ExecPhaseOptions = {
  inPath: string;
  outPath: string;
  // Injectable verifier seam. Production omits it and the phase binds the real
  // runReproVerifier + realReproVerifierIo lazily; tests inject a stub so no
  // subprocess is ever spawned.
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
      // spec abort the batch. Shape a synthetic inconclusive record.
      records.push({
        reviewId: spec.reviewId,
        findingId: spec.findingId,
        verdict: "inconclusive",
        inconclusiveReason: "exception",
        reproPreExitCode: null,
        reproPostExitCode: null,
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
// record phase — WITH the DB secret, but WRITE-gated. Default dry-run.
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

  if (!opts.record) {
    log("[record] DRY-RUN (no --record) — the following rows WOULD be written:");
    for (const v of verdicts) {
      log(
        `[record]   review=${v.reviewId} finding=${v.findingId} stage=repro_verify ` +
          `verdict=${v.verdict}`,
      );
    }
    log(`[record] dry-run complete; wrote nothing (${verdicts.length} row(s) suppressed)`);
    return 0;
  }

  const write = opts.writeGateOutcome ?? (await realGateWriter());
  let written = 0;
  for (const v of verdicts) {
    await write(v.reviewId, {
      findingId: v.findingId,
      verdict: v.verdict,
      evidence: v,
    });
    written++;
  }
  log(`[record] wrote ${written} review_gate_outcomes row(s) (stage=repro_verify)`);
  return written;
}

// ────────────────────────────────────────────────────────────────────────
// Parsing helpers (exported for tests) — tolerant JSON readers that fail LOUD
// on a non-array so a corrupt artifact never silently produces an empty run.
// ────────────────────────────────────────────────────────────────────────

export function parseSpecs(json: string): ReproSpec[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("repro-specs file did not contain a JSON array");
  return parsed as ReproSpec[];
}

export function parseVerdicts(json: string): VerdictRecord[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("repro-verdicts file did not contain a JSON array");
  return parsed as VerdictRecord[];
}

// ── Finding reconstruction — kept identical to bench-dryrun's projection so a
// finding fed here is byte-for-byte the one the patch verifier would have seen.
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

function parseFindingIndex(findingId: string): number | null {
  const m = /-(\d+)$/u.exec(findingId);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function findingIdMatchesAgreed(idx: number, findings: AgreedFinding[]): boolean {
  if (idx < 0 || idx >= findings.length) return false;
  const f = findings[idx];
  if (f === undefined) return false;
  // The verifier refuses to anchor a repro without an evidence path, so drop
  // the candidate at pairing time rather than spend a generation call.
  if (f.evidence.length === 0) return false;
  return true;
}

function extractAgreed(agreementDecision: unknown): AgreedFinding[] {
  if (agreementDecision === null || typeof agreementDecision !== "object") return [];
  const obj = agreementDecision as Record<string, unknown>;
  const agreed = obj["agreed"];
  if (!Array.isArray(agreed)) return [];
  const out: AgreedFinding[] = [];
  for (const item of agreed) {
    if (item === null || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const title = typeof f["title"] === "string" ? f["title"] : null;
    const category = typeof f["category"] === "string" ? f["category"] : null;
    const severity = f["severity"];
    if (title === null || category === null) continue;
    if (
      severity !== "critical" &&
      severity !== "high" &&
      severity !== "medium" &&
      severity !== "low"
    ) {
      continue;
    }
    const evidence = Array.isArray(f["evidence"]) ? f["evidence"] : [];
    out.push({
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
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Real dependency wiring — lazy dynamic imports ONLY (mirrors bench-dryrun).
// No top-level DB / provider import so importing this module for tests is inert.
// ────────────────────────────────────────────────────────────────────────

async function realFetchDeps(): Promise<FetchDeps> {
  const { db } = await import("@/db");
  const { reviews, findingStatus } = await import("@/db/schema");
  const { sql, eq, and, gte } = await import("drizzle-orm");
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
    loadCandidates: async (limit, repoFilter) => {
      const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
      const rows = await db
        .select({
          reviewId: reviews.reviewId,
          owner: reviews.owner,
          repo: reviews.repo,
          prNumber: reviews.prNumber,
          commitSha: reviews.commitSha,
          agreementDecision: reviews.agreementDecision,
          createdAt: reviews.createdAt,
        })
        .from(reviews)
        .where(gte(reviews.createdAt, since))
        .orderBy(sql`${reviews.createdAt} DESC`)
        .limit(REVIEW_SCAN_LIMIT);

      const out: CandidateRow[] = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        if (r.owner === null || r.repo === null) continue;
        if (repoFilter !== null && `${r.owner}/${r.repo}` !== repoFilter) continue;
        // Only keep reviews that actually carry a suggested patch — the verifier
        // needs one. Join finding_status the same way bench-dryrun does.
        const statuses = await db
          .select({
            findingId: findingStatus.findingId,
            suggestedPatch: findingStatus.suggestedPatch,
          })
          .from(findingStatus)
          .where(and(eq(findingStatus.reviewId, r.reviewId)));
        const withPatch = statuses.filter((s) => s.suggestedPatch !== null);
        if (withPatch.length === 0) continue;
        out.push({
          reviewId: r.reviewId,
          owner: r.owner,
          repo: r.repo,
          prNumber: r.prNumber,
          commitSha: r.commitSha,
          agreementDecision: r.agreementDecision,
          findingStatuses: statuses.map((s) => ({
            findingId: s.findingId,
            suggestedPatch: s.suggestedPatch,
          })),
        });
      }
      return out;
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
  };
}

async function realVerifier(): Promise<(spec: ReproSpec) => Promise<PatchVerifyOutcome>> {
  const { runReproVerifier, realReproVerifierIo } = await import("@/lib/repro-verifier");
  return async (spec: ReproSpec) =>
    runReproVerifier({
      repoUrl: spec.repoUrl,
      sha: spec.sha,
      patch: spec.patch,
      repro: spec.repro,
      finding: minimalFindingForVerify(),
      io: await realReproVerifierIo(),
    });
}

// runReproVerifier requires a Finding on args but only reads it for logging /
// context — the repro is self-contained in the spec. The spec does not carry
// the reconstructed Finding across the secretless boundary (it is DB-derived),
// so we pass a minimal placeholder here. The verdict is driven entirely by the
// repro cmd + patch, not by these fields.
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
      stage: "repro_verify" as "patch_verify",
      verdict: row.verdict,
      evidence: row.evidence,
      modelId: null,
    });
  };
}

// ────────────────────────────────────────────────────────────────────────
// CLI entrypoint
// ────────────────────────────────────────────────────────────────────────

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const { get, has } = parseArgs(argv);
  const phase = get("--phase");

  if (phase === "fetch") {
    // Secrets live here (DATABASE_URL + ANTHROPIC_API_KEY). This is the ONLY
    // phase that loads the env file.
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
