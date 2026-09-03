// `antfleet-audit sweep` — batch runner over MANY entry contracts in one
// target repo. Reuses the exact single-entry pipeline (closure assembly →
// runFinder → report) via `auditEntry`, fanning it out across entries with a
// bounded promise pool so a 30+ contract sweep is one command, not one
// invocation per contract.
//
// Everything here is pure/testable (no process.exit, no argv parsing) except
// `auditEntry` itself, which performs the real closure assembly + (in --live)
// model calls. Tests inject a fake `auditFn` — see sweep.test.ts.

import {
  isTestOrMockPath,
  isLibraryPath,
  assembleClosure,
  fsReadRepoFile,
  type ClosureResult,
} from "./closure.js";
import { auditModelCall, confirmModelCall, pocModelCall } from "./model-client.js";
import {
  runFinder,
  type ConfirmCallback,
  type ExecutePocCallback,
  type FinderRunResult,
  type GeneratePocCallback,
  type RefuteCallback,
} from "./run.js";
import { makeDockerExecutePoc } from "./poc-executor.js";
import { refuteFinding, refuterTransport } from "./refuter.js";
import { buildFocusedConfirmPrompt } from "./prompt.js";
import { buildPocGenerationPrompt, parsePocGenerationOutput } from "./poc-prompt.js";
import {
  EMPTY_CONTEXT_PACK,
  extractNatSpecTrustHints,
  renderSystemBrief,
  type ContextPack,
} from "./context-pack.js";
import type { ScoredFinding } from "./run.js";
import type { AuditFinding } from "./finding-schema.js";

// --- Single-entry pipeline (task 1: factored out of cli.ts for reuse) -------

export type AuditEntryArgs = {
  /** Resolved (or resolvable) target root directory. */
  root: string;
  /**
   * Repo-relative entry path(s) forming ONE audit/closure. Plural because the
   * existing single-audit CLI mode already supports multiple `--entry` flags
   * feeding one combined closure — that behavior must not change. Sweep calls
   * this once per contract with a single-element array.
   */
  entries: string[];
  programRules: string;
  budgetBytes: number;
  /** Pre-listed .sol paths under root (listSolFiles) — callers compute once. */
  allPaths: readonly string[];
  /** Pre-loaded remappings (loadRemappings) — callers compute once. */
  remappings: readonly (readonly [string, string])[];
  live: boolean;
  finderModel?: string | undefined;
  /** Stage-B focused-confirm model override (default gpt-5.5, set in model-client). */
  confirmModel?: string | undefined;
  /** Phase 0 off-chain context (docs/audits/trust-model), assembled once per repo. */
  contextPack?: ContextPack | undefined;
  /** Opt-in post-PURSUE PoC generation (--poc, §7 Phase 1: generation-only —
   * CANDIDATE attached, verdict does not move; the executor is Phase 3). */
  poc?: boolean | undefined;
  /** PoC generation model override (default gpt-5.5). */
  pocModel?: string | undefined;
  /** Opt-in post-PURSUE PoC EXECUTION (--poc-exec / SIDECAR_POC_EXEC; requires --poc +
   * --live). Runs the generated PoC in the Docker sandbox (§3.4). Without a valid
   * enablement manifest (§4) it stays execute-only — an executed CANDIDATE is attached
   * and the verdict does NOT move (tier-not-enabled-by-operator). */
  pocExec?: boolean | undefined;
  /** Executor image (default `antfleet-poc-exec:local` / $SIDECAR_POC_IMAGE). */
  pocImage?: string | undefined;
  /** Defaults to console.error; injectable so sweep can label/silence lines. */
  log?: ((line: string) => void) | undefined;
};

export type AuditEntryResult = {
  entries: string[];
  closure: ClosureResult;
  result: FinderRunResult;
};

function fmtBytes(n: number): string {
  return `${(n / 1000).toFixed(1)}k chars`;
}

/**
 * The single-entry audit: closure assembly (component A) → two-stage finder +
 * refuter (component B/C, run.ts) → structured result. DRY-RUN by default
 * (no model call); `live: true` wires the real finder/refuter/confirm
 * transports exactly as cli.ts did before this refactor.
 */
export async function auditEntry(args: AuditEntryArgs): Promise<AuditEntryResult> {
  const log = args.log ?? ((line: string) => console.error(line));
  const closure = await assembleClosure({
    entries: args.entries,
    allPaths: args.allPaths,
    readFile: fsReadRepoFile(args.root),
    budgetBytes: args.budgetBytes,
    remappings: args.remappings,
  });

  const rolesFor = (p: string): string => closure.roles.get(p) ?? "?";
  log("[audit-solidity] closure assembled:");
  for (const block of closure.blocks) {
    log(`  [${rolesFor(block.path)}] ${block.path} (${fmtBytes(block.contents.length)})`);
  }
  for (const evicted of closure.evicted) {
    log(`  [evicted] ${evicted}`);
  }
  for (const external of closure.externalUnresolved) {
    log(`  [unresolved external] ${external}`);
  }
  log(
    `  total: ${closure.blocks.length} file(s), ${fmtBytes(closure.bytes)}, truncated=${closure.truncated}${closure.entryOverflow ? " (ENTRY OVERFLOW — entries kept whole)" : ""}`,
  );
  if (closure.externalUnresolved.length > 0) {
    log(
      `[audit-solidity] WARNING: incomplete closure — ${closure.externalUnresolved.length} unresolved external(s); the prompt states this honestly.`,
    );
  }
  if (closure.evictedFirstParty.length > 0) {
    // Issue #178: losing a FIRST-PARTY file to the budget is the loud case — the
    // operator's own code went un-audited, not just a dependency. Libraries are
    // already evicted first, so this means first-party bulk alone overflowed:
    // raise --budget or narrow --entry (or sweep, which audits each file as its
    // own never-evicted entry).
    log(
      `[audit-solidity] WARNING: ${closure.evictedFirstParty.length} FIRST-PARTY file(s) EVICTED (un-audited) under budget: ${closure.evictedFirstParty.join(", ")} — raise --budget or run a sweep so each is its own entry.`,
    );
  }

  // Phase 0: per-repo docs/audits pack + this entry's own NatSpec off-chain hints.
  const pack = args.contextPack ?? EMPTY_CONTEXT_PACK;
  const entryHints = extractNatSpecTrustHints(closure.blocks);
  const systemContext = renderSystemBrief(pack, entryHints);
  if (args.live && systemContext.length > 0) {
    log(
      `[audit-solidity] Phase 0 context active: ${pack.sources.length} doc/audit source(s), ${entryHints.length} NatSpec hint(s), ${pack.knownIssues.length} known-issue(s)`,
    );
  }

  const finderOpts = args.finderModel === undefined ? undefined : { model: args.finderModel };
  const confirmOpts = args.confirmModel === undefined ? undefined : { model: args.confirmModel };
  if (args.live && args.finderModel !== undefined) {
    log(`[audit-solidity] stage-A finder routed to model: ${args.finderModel}`);
  }
  if (args.live && args.confirmModel !== undefined) {
    log(`[audit-solidity] stage-B confirm routed to model: ${args.confirmModel}`);
  }
  const finderTransport = args.live
    ? async (prompt: string) => {
        const { payload, truncated } = await auditModelCall(prompt, finderOpts);
        return { payload, truncated };
      }
    : undefined;
  const refuterCallback: RefuteCallback | undefined = args.live
    ? async ({ finding }) => {
        const r = await refuteFinding(
          {
            finding,
            files: closure.blocks,
            programRules: args.programRules,
            priorFindings: pack.knownIssues, // Phase 0: repo audit findings → DUPLICATE corpus
            contextPack: pack, // Phase 0: enables + grounds off-chain kill-grounds
          },
          refuterTransport, // WITHOUT this, refuteFinding returns the dry-run KILLED stub
        );
        return { verdict: r.verdict, reason: r.reason } as const;
      }
    : undefined;
  // Stage B (focused confirm) runs on the CONFIRM model (default gpt-5.5), NOT
  // the finder model: the "complete this fund-extraction chain" prompt trips the
  // ChatGPT cyber content filter on gpt-5.6-sol; gpt-5.5 clears it.
  const confirmCallback: ConfirmCallback | undefined = args.live
    ? async ({ finding, focusedFiles, programRules: rules }) => {
        const prompt = buildFocusedConfirmPrompt({
          finding: {
            title: finding.title,
            severity: finding.severity,
            confidence: finding.confidence,
            reasoning: finding.reasoning,
            evidence: finding.evidence,
            triggerRole: finding.triggerRole,
            preconditions: finding.preconditions,
          },
          files: focusedFiles,
          programRules: rules,
          systemContext,
        });
        const { payload, truncated } = await confirmModelCall(prompt, confirmOpts);
        return { payload, truncated };
      }
    : undefined;

  // Phase 1 generation-only: build + call the PoC generation model and parse it.
  // No executor is wired here (Phase 3, §7 spike-gated) — findings with a
  // gate-passing CANDIDATE PoC stay PURSUE.
  const pocOpts = args.pocModel === undefined ? undefined : { model: args.pocModel };
  const generatePoc: GeneratePocCallback | undefined =
    args.live && args.poc === true
      ? async ({ finding, pocTarget, files, programRules: rules }) => {
          const prompt = buildPocGenerationPrompt({
            finding: {
              title: finding.title,
              severity: finding.severity,
              confidence: finding.confidence,
              reasoning: finding.reasoning,
              evidence: finding.evidence,
              triggerRole: finding.triggerRole,
              preconditions: finding.preconditions,
            },
            pocTarget,
            files,
            programRules: rules,
            systemContext,
          });
          const { payload } = await pocModelCall(prompt, pocOpts);
          return parsePocGenerationOutput(payload);
        }
      : undefined;
  // Phase-2 executor (opt-in --poc-exec): runs each gate-passing PoC in the Docker
  // sandbox (§3.4). `activeGo` is left undefined until a valid enablement manifest
  // (§4) is wired, so this is execute-only — executed CANDIDATE attached, verdict
  // unchanged. Composed only with --live + --poc + --poc-exec.
  const executePoc: ExecutePocCallback | undefined =
    args.live && args.poc === true && args.pocExec === true
      ? makeDockerExecutePoc({
          image: args.pocImage ?? process.env["SIDECAR_POC_IMAGE"] ?? "antfleet-poc-exec:local",
          targetRoot: args.root,
        })
      : undefined;
  if (args.live && args.poc === true) {
    log(
      executePoc === undefined
        ? "[audit-solidity] --poc: generation-only PoC stage active (executor off; pass --poc-exec to run)"
        : "[audit-solidity] --poc --poc-exec: sandboxed executor active (execute-only until an enablement manifest is wired)",
    );
  }

  const result = await runFinder(
    {
      projectName: args.root.split("/").pop() ?? "target",
      entries: args.entries,
      files: closure.blocks,
      programRules: args.programRules,
      // §3.3.A anchor (PoC stage only) resolves vendored-scaffolding imports
      // against the repo's remappings; harmless/unused when --poc is off.
      remappings: args.remappings,
      systemContext,
      closureStats: {
        truncated: closure.truncated,
        evicted: closure.evicted,
        externalUnresolved: closure.externalUnresolved,
      },
    },
    finderTransport,
    refuterCallback,
    confirmCallback,
    generatePoc,
    executePoc,
  );

  return { entries: args.entries, closure, result };
}

// --- Live report rendering (shared by single-audit cli.ts + sweep) ---------

/**
 * The exact --live report shape cli.ts rendered inline before this refactor
 * (byte-identical output — copied, not reinvented) so single-audit mode's
 * behavior is unchanged.
 */
export function renderLiveReport(args: {
  entries: readonly string[];
  closure: ClosureResult;
  result: FinderRunResult;
}): { json: Record<string, unknown>; md: string } {
  const { entries, closure, result } = args;
  const lines: string[] = [];
  lines.push(`# Solidity finder report — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    `- Closure: ${closure.blocks.length} file(s), ${fmtBytes(closure.bytes)}, truncated=${closure.truncated}${result.truncated ? "; MODEL OUTPUT TRUNCATED (INCOMPLETE)" : ""}`,
  );
  lines.push(`- Entries: ${entries.join(", ")}`);
  if (closure.evicted.length > 0) {
    lines.push(`- Evicted over budget (NOT audited): ${closure.evicted.join(", ")}`);
  }
  if (closure.evictedFirstParty.length > 0) {
    lines.push(
      `- ⚠️ FIRST-PARTY EVICTED (own code un-audited — raise --budget or sweep): ${closure.evictedFirstParty.join(", ")}`,
    );
  }
  if (closure.externalUnresolved.length > 0) {
    lines.push(
      `- Unresolved externals (INCOMPLETE CLOSURE): ${closure.externalUnresolved.join(", ")}`,
    );
  }
  lines.push(
    `- Findings: ${result.findings.length} (${result.pursueCount} PURSUE / ${result.droppedCount} DROP` +
      `${result.confirmedVerdictCount !== undefined ? ` / ${result.confirmedVerdictCount} CONFIRMED` : ""}` +
      `${result.pocExecutedVerdictCount !== undefined ? ` / ${result.pocExecutedVerdictCount} POC_EXECUTED` : ""})`,
  );
  if (result.pocAttemptedCount !== undefined) {
    lines.push(
      `- PoC stage: ${result.pocAttemptedCount} attempted, ${result.pocRanCount ?? 0} executed, ${result.pocSkippedInfraCount ?? 0} skipped (executor off / infra). ` +
        `CONFIRMED = direct-drive, executed (strong); POC_EXECUTED = harness-driven, executed (weaker); ` +
        `both are human-review-required and local-deploy only; absence does not lower severity ` +
        `(fork / test-authored attacker or dependency / repo-src collaborator / token-balance / signature classes cannot earn either).`,
    );
  }
  if (result.rejectedRaw.length > 0) {
    lines.push(`- Unparseable findings (raw preserved below): ${result.rejectedRaw.length}`);
  }
  lines.push("");
  lines.push("## Scored findings");
  lines.push("");
  for (const s of result.scored) {
    lines.push(`### **${s.verdict}** — ${s.finding.title} [${s.finding.severity}]`);
    lines.push(`- reason: ${s.reason}`);
    if (s.advisory !== "no adverse advisory factors") {
      lines.push(`- advisory (model self-report, NOT a gate): ${s.advisory}`);
    }
    lines.push(`- triggerRole: ${s.finding.triggerRole}`);
    lines.push(`- preconditions: ${s.finding.preconditions}`);
    for (const e of s.finding.evidence) {
      lines.push(`- evidence: \`${e.path}:${e.startLine ?? "?"}-${e.endLine ?? "?"}\``);
    }
    lines.push(`- reasoning: ${s.finding.reasoning}`);
    if (s.poc !== undefined) {
      if (s.verdict === "CONFIRMED") {
        lines.push(
          `- PoC: CONFIRMED — direct-drive, executed & deploy-verified (strong, human-review-required); test \`${s.poc.testPath}\``,
        );
      } else if (s.verdict === "POC_EXECUTED") {
        lines.push(
          `- PoC: POC_EXECUTED — harness-driven, executed & deploy-verified (weaker than CONFIRMED, human-review-required); test \`${s.poc.testPath}\``,
        );
      } else if (s.poc.staticGate.passed && s.poc.execution?.passed === true) {
        lines.push(
          `- PoC: **CANDIDATE — executed & PASSED but its tier is not enabled this build**, so it ` +
            `stays PURSUE (human-review-required); a higher-trust candidate than generated-only. test \`${s.poc.testPath}\``,
        );
      } else if (s.poc.staticGate.passed && s.poc.executed) {
        lines.push(
          `- PoC: **CANDIDATE — executed but the test did NOT pass / did not compile** (${
            s.poc.execution?.reason ?? "see run"
          }); stays PURSUE. test \`${s.poc.testPath}\``,
        );
      } else if (s.poc.staticGate.passed) {
        lines.push(
          `- PoC: **CANDIDATE — generated, NOT executed, correctness AND relevance unverified**; ` +
            `run only in an isolated sandbox (offline, non-root), never against a checkout with real secrets. test \`${s.poc.testPath}\``,
        );
      } else if (s.poc.generated) {
        lines.push(
          `- PoC: generated but failed static gate — ${s.poc.staticGate.reasons.join("; ")}`,
        );
      } else {
        lines.push(`- PoC: not generated — ${s.poc.rationale ?? "n/a"}`);
      }
    }
    lines.push("");
  }
  if (result.rejectedRaw.length > 0) {
    lines.push("## Unparseable raw findings (preserved for inspection)");
    for (const r of result.rejectedRaw) {
      lines.push(`- index ${r.index}: ${JSON.stringify(r.raw)}`);
    }
    lines.push("");
  }
  const md = lines.join("\n");
  const json: Record<string, unknown> = {
    schemaVersion: 2,
    closure: {
      includedFiles: closure.blocks.map((b) => b.path),
      evicted: closure.evicted,
      evictedFirstParty: closure.evictedFirstParty,
      externalUnresolved: closure.externalUnresolved,
      bytes: closure.bytes,
      truncated: closure.truncated,
    },
    modelTruncated: result.truncated,
    ...result,
  };
  return { json, md };
}

/**
 * Sweep's DRY-RUN per-entry report: no model call, but (unlike single-audit
 * mode's raw-prompt-only file) includes closure stats alongside the rendered
 * prompt so an operator can eyeball the plan/cost surface for every entry
 * before spending anything.
 */
export function renderDryRunEntryReport(args: {
  entries: readonly string[];
  closure: ClosureResult;
  result: FinderRunResult;
}): { json: Record<string, unknown>; md: string } {
  const { entries, closure, result } = args;
  const lines: string[] = [];
  lines.push(`# Solidity finder report (DRY-RUN) — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`- Entries: ${entries.join(", ")}`);
  lines.push(
    `- Closure: ${closure.blocks.length} file(s), ${fmtBytes(closure.bytes)}, truncated=${closure.truncated}${closure.entryOverflow ? " (ENTRY OVERFLOW)" : ""}`,
  );
  if (closure.evicted.length > 0) {
    lines.push(`- Evicted over budget (NOT audited): ${closure.evicted.join(", ")}`);
  }
  if (closure.evictedFirstParty.length > 0) {
    lines.push(
      `- ⚠️ FIRST-PARTY EVICTED (own code un-audited — raise --budget or sweep): ${closure.evictedFirstParty.join(", ")}`,
    );
  }
  if (closure.externalUnresolved.length > 0) {
    lines.push(
      `- Unresolved externals (INCOMPLETE CLOSURE): ${closure.externalUnresolved.join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## Prompt (no model call — dry-run)");
  lines.push("");
  lines.push(result.prompt);
  const md = lines.join("\n");
  const json: Record<string, unknown> = {
    schemaVersion: 2,
    live: false,
    entries,
    closure: {
      includedFiles: closure.blocks.map((b) => b.path),
      evicted: closure.evicted,
      evictedFirstParty: closure.evictedFirstParty,
      externalUnresolved: closure.externalUnresolved,
      bytes: closure.bytes,
      truncated: closure.truncated,
    },
    prompt: result.prompt,
  };
  return { json, md };
}

// --- Entry-set utilities -----------------------------------------------------

/** Parse `--entries-from` file contents: one repo-relative .sol path per
 * non-blank, non-`#`-comment line. */
export function parseEntriesFromFile(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Sanitize a repo-relative entry path into a filesystem-safe directory name. */
export function sanitizeEntryPath(entry: string): string {
  return entry.replace(/[^A-Za-z0-9._-]/gu, "_");
}

const CONTRACT_OR_LIBRARY_DECL_REGEX = /\b(?:abstract\s+)?(?:contract|library)\s+[A-Za-z_$]/u;
const INTERFACE_DECL_REGEX = /\binterface\s+[A-Za-z_$]/u;

/** True when a file declares ONLY interfaces (no contract/library) — the
 * `--entries-glob` exclusion target alongside test/mock/script paths. */
export function isInterfaceOnlyFile(contents: string): boolean {
  return INTERFACE_DECL_REGEX.test(contents) && !CONTRACT_OR_LIBRARY_DECL_REGEX.test(contents);
}

/** Minimal glob→RegExp: `**` matches across `/`, `*` matches within a
 * segment, `?` matches one char. Enough for typical `contracts/**\/*.sol`
 * patterns; not a full glob implementation. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c !== undefined && /[.+^${}()|[\]\\]/u.test(c)) {
      re += `\\${c}`;
    } else {
      re += c ?? "";
    }
  }
  return new RegExp(`^${re}$`, "u");
}

/**
 * Issue #178 — "sweep by default": enumerate every FIRST-PARTY contract entry
 * under the target (non-test, non-library, non-interface-only .sol). This is
 * the guided path so an operator no longer has to guess the single right
 * `--entry`; each file becomes its own never-evicted entry and no bug can be
 * skimmed past for living in a non-entry sibling. Same exclusion policy as
 * `--entries-glob`, minus the glob filter and plus a library-root exclusion.
 */
export async function enumerateFirstPartyEntries(args: {
  allPaths: readonly string[];
  readFile: (repoRelativePath: string) => Promise<string>;
}): Promise<string[]> {
  const candidates = args.allPaths.filter((p) => !isTestOrMockPath(p) && !isLibraryPath(p));
  const out: string[] = [];
  for (const candidate of candidates) {
    const contents = await args.readFile(candidate);
    if (!isInterfaceOnlyFile(contents)) {
      out.push(candidate);
    }
  }
  return out.toSorted();
}

/** Resolve `--entries-glob` against the target's .sol tree, excluding
 * test/mock/script (closure.ts's isTestOrMockPath) and interface-only files. */
export async function resolveEntriesGlob(args: {
  glob: string;
  allPaths: readonly string[];
  readFile: (repoRelativePath: string) => Promise<string>;
}): Promise<string[]> {
  const regex = globToRegExp(args.glob);
  const candidates = args.allPaths.filter((p) => regex.test(p) && !isTestOrMockPath(p));
  const out: string[] = [];
  for (const candidate of candidates) {
    const contents = await args.readFile(candidate);
    if (!isInterfaceOnlyFile(contents)) {
      out.push(candidate);
    }
  }
  return out;
}

// --- Bounded promise pool -----------------------------------------------------

/** Runs `worker` over `items` with at most `concurrency` in flight at once.
 * `worker` is expected to catch its own errors (never reject) so one bad item
 * cannot abort the rest of the pool — see sweep.test.ts. */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) {
        return;
      }
      const item = items[i] as T;
      results[i] = await worker(item, i);
    }
  };
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () =>
    lane(),
  );
  await Promise.all(lanes);
  return results;
}

// --- Sweep aggregation --------------------------------------------------------

export type SweepEntryOutcome = {
  entry: string;
  status: "ran" | "error";
  pursue: number;
  drop: number;
  findings: number;
  truncated: boolean;
  error?: string;
  /** PoC-stage counters — present only on a --poc run (§4 coverage). Canonical
   * names: verdict tallies vs executions run are never conflated. */
  confirmedVerdictCount?: number;
  pocExecutedVerdictCount?: number;
  pocAttemptedCount?: number;
  pocRanCount?: number;
  pocSkippedInfraCount?: number;
};

export type SweepSummary = {
  ranAt: string;
  live: boolean;
  target: string;
  concurrency: number;
  entries: SweepEntryOutcome[];
  totals: {
    entries: number;
    pursue: number;
    drop: number;
    errors: number;
    /** PoC-stage totals — present only when some entry ran the --poc stage. */
    confirmedVerdictCount?: number;
    pocExecutedVerdictCount?: number;
    pocAttemptedCount?: number;
    pocRanCount?: number;
    pocSkippedInfraCount?: number;
  };
};

export function buildSweepSummary(args: {
  ranAt: string;
  live: boolean;
  target: string;
  concurrency: number;
  outcomes: readonly SweepEntryOutcome[];
}): SweepSummary {
  const totals: SweepSummary["totals"] = {
    entries: args.outcomes.length,
    pursue: args.outcomes.reduce((sum, o) => sum + o.pursue, 0),
    drop: args.outcomes.reduce((sum, o) => sum + o.drop, 0),
    errors: args.outcomes.filter((o) => o.status === "error").length,
  };
  // PoC totals are added ONLY when at least one entry ran the --poc stage, so a
  // non-`--poc` sweep summary is byte-identical to before (§4).
  if (args.outcomes.some((o) => o.pocAttemptedCount !== undefined)) {
    const sum = (pick: (o: SweepEntryOutcome) => number | undefined): number =>
      args.outcomes.reduce((acc, o) => acc + (pick(o) ?? 0), 0);
    totals.confirmedVerdictCount = sum((o) => o.confirmedVerdictCount);
    totals.pocExecutedVerdictCount = sum((o) => o.pocExecutedVerdictCount);
    totals.pocAttemptedCount = sum((o) => o.pocAttemptedCount);
    totals.pocRanCount = sum((o) => o.pocRanCount);
    totals.pocSkippedInfraCount = sum((o) => o.pocSkippedInfraCount);
  }
  return {
    ranAt: args.ranAt,
    live: args.live,
    target: args.target,
    concurrency: args.concurrency,
    entries: [...args.outcomes],
    totals,
  };
}

/** One entry's PURSUE findings, for PURSUE.md aggregation. */
export type EntryPursueFindings = { entry: string; scored: readonly ScoredFinding[] };

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** A finding that earns a roll-up row: PURSUE or its post-PURSUE promotion
 * CONFIRMED (§4 — CONFIRMED must never be dropped by a `verdict === "PURSUE"`
 * filter). No-op in the generation-only tier, which never produces CONFIRMED. */
function isRolledUp(s: ScoredFinding): boolean {
  return s.verdict === "PURSUE" || s.verdict === "CONFIRMED" || s.verdict === "POC_EXECUTED";
}

/**
 * Aggregate PURSUE roll-up across the whole sweep. Entries sorted with the
 * most/severest PURSUE first (PURSUE count desc, tie-broken by the highest
 * severity present among that entry's PURSUE findings).
 */
export function buildPursueMarkdown(entries: readonly EntryPursueFindings[]): string {
  const withPursue = entries
    .map((e) => ({ entry: e.entry, pursue: e.scored.filter(isRolledUp) }))
    .filter((e) => e.pursue.length > 0);

  const maxSeverityRank = (list: readonly ScoredFinding[]): number =>
    list.reduce((max, s) => Math.max(max, SEVERITY_ORDER[s.finding.severity] ?? 0), 0);

  const sorted = withPursue.toSorted((a, b) => {
    if (b.pursue.length !== a.pursue.length) {
      return b.pursue.length - a.pursue.length;
    }
    return maxSeverityRank(b.pursue) - maxSeverityRank(a.pursue);
  });

  const totalPursue = sorted.reduce((sum, e) => sum + e.pursue.length, 0);
  const lines: string[] = [];
  lines.push(`# PURSUE roll-up — ${totalPursue} finding(s) across ${sorted.length} entry(ies)`);
  lines.push("");
  if (sorted.length === 0) {
    lines.push("No PURSUE findings.");
    return lines.join("\n");
  }
  for (const { entry, pursue } of sorted) {
    lines.push(`## ${entry} (${pursue.length} PURSUE)`);
    lines.push("");
    for (const s of pursue) {
      const tag =
        s.verdict === "CONFIRMED"
          ? " _(CONFIRMED — direct-drive PoC-executed, human-review-required)_"
          : s.verdict === "POC_EXECUTED"
            ? " _(POC_EXECUTED — harness-driven, executed, weaker than CONFIRMED, human-review-required)_"
            : "";
      lines.push(`- **[${s.finding.severity}]** ${s.finding.title}${tag}`);
      for (const e of s.finding.evidence) {
        lines.push(`  - evidence: \`${e.path}:${e.startLine ?? "?"}-${e.endLine ?? "?"}\``);
      }
      const reasoning = s.finding.reasoning.split(/\r?\n/u)[0] ?? s.finding.reasoning;
      lines.push(`  - reasoning: ${reasoning}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Cross-entry dedup key for a PURSUE finding (issue #178). The same bug surfaced
 * from two different entry closures shares BOTH its evidence anchors and its
 * title, so the key combines the sorted set of `path:startLine` citations with
 * the normalized title. Title is part of the key deliberately: two DISTINCT bugs
 * can cite the same starting line (a packed line, a shared guard/modifier), and
 * anchors alone would collapse them into one union row and hide the second.
 * `startLine` (not the full range) is the anchor so a confirm-stage re-anchor to
 * a nearby end line still dedupes. Anchorless findings fall back to title only.
 */
export function pursueFindingDedupKey(finding: AuditFinding): string {
  const title = finding.title.trim().toLowerCase().replace(/\s+/gu, " ");
  const anchors = finding.evidence
    .map((e) => `${e.path}:${e.startLine ?? "?"}`)
    .filter((a) => a !== "(unanchored):?")
    .toSorted();
  if (anchors.length > 0) {
    return `${anchors.join("|")}##${title}`;
  }
  return `title:${title}`;
}

/**
 * Issue #178 — the UNION view across the whole sweep: every PURSUE finding
 * deduplicated across entries by {@link pursueFindingDedupKey}, so a bug two
 * entries both reach is listed once with the set of entries that surfaced it.
 * The per-entry breakdown lives in {@link buildPursueMarkdown}; the CLI writes
 * this union first so the operator reads the deduped whole-system picture up top.
 */
/** Strength rank of a terminal PoC verdict (CONFIRMED > POC_EXECUTED > other). */
function verdictRank(v: ScoredFinding["verdict"]): number {
  return v === "CONFIRMED" ? 2 : v === "POC_EXECUTED" ? 1 : 0;
}

export function buildDedupedPursueMarkdown(entries: readonly EntryPursueFindings[]): string {
  // Track the STRONGEST verdict tier across the group so the union never collapses
  // a CONFIRMED and a POC_EXECUTED of the same finding into an untagged row.
  type Group = {
    rep: ScoredFinding;
    severityRank: number;
    bestVerdict: ScoredFinding["verdict"];
    entries: Set<string>;
  };
  const groups = new Map<string, Group>();
  let rawPursue = 0;
  for (const { entry, scored } of entries) {
    for (const s of scored) {
      if (!isRolledUp(s)) {
        continue;
      }
      rawPursue += 1;
      const key = pursueFindingDedupKey(s.finding);
      const rank = SEVERITY_ORDER[s.finding.severity] ?? 0;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          rep: s,
          severityRank: rank,
          bestVerdict: s.verdict,
          entries: new Set([entry]),
        });
        continue;
      }
      existing.entries.add(entry);
      if (rank > existing.severityRank) {
        existing.rep = s;
        existing.severityRank = rank; // keep the highest-severity representative
      }
      if (verdictRank(s.verdict) > verdictRank(existing.bestVerdict)) {
        existing.bestVerdict = s.verdict; // keep the strongest tier seen
      }
    }
  }

  const uniques = [...groups.values()].toSorted((a, b) => {
    if (b.severityRank !== a.severityRank) {
      return b.severityRank - a.severityRank;
    }
    const ta = a.rep.finding.title;
    const tb = b.rep.finding.title;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

  const lines: string[] = [];
  lines.push(
    `# PURSUE union — ${uniques.length} unique finding(s) (${rawPursue} raw across ${entries.length} entry(ies))`,
  );
  lines.push("");
  if (uniques.length === 0) {
    lines.push("No PURSUE findings.");
    return lines.join("\n");
  }
  for (const { rep, bestVerdict, entries: surfacedFrom } of uniques) {
    const f = rep.finding;
    const tierTag =
      bestVerdict === "CONFIRMED"
        ? " _(CONFIRMED)_"
        : bestVerdict === "POC_EXECUTED"
          ? " _(POC_EXECUTED)_"
          : "";
    lines.push(`## **[${f.severity}]** ${f.title}${tierTag}`);
    lines.push(`- surfaced from: ${[...surfacedFrom].toSorted().join(", ")}`);
    for (const e of f.evidence) {
      lines.push(`- evidence: \`${e.path}:${e.startLine ?? "?"}-${e.endLine ?? "?"}\``);
    }
    const reasoning = f.reasoning.split(/\r?\n/u)[0] ?? f.reasoning;
    lines.push(`- reasoning: ${reasoning}`);
    lines.push("");
  }
  return lines.join("\n");
}

// --- Sweep orchestration (testable independent of FS / CLI wiring) ---------

export type SweepRunOutcome = {
  outcome: SweepEntryOutcome;
  closure: ClosureResult | null;
  result: FinderRunResult | null;
};

/**
 * Runs every entry through `auditFn` with the given concurrency cap. A
 * throwing `auditFn` is caught per-entry and recorded as `status: "error"` —
 * it never aborts the rest of the sweep.
 */
export async function runSweepAudits(args: {
  entries: readonly string[];
  concurrency: number;
  auditFn: (entry: string) => Promise<AuditEntryResult>;
}): Promise<SweepRunOutcome[]> {
  return runPool(args.entries, args.concurrency, async (entry): Promise<SweepRunOutcome> => {
    try {
      const { closure, result } = await args.auditFn(entry);
      return {
        outcome: {
          entry,
          status: "ran",
          pursue: result.pursueCount,
          drop: result.droppedCount,
          findings: result.findings.length,
          truncated: result.truncated,
          // PoC counters ride along ONLY when the --poc stage ran (undefined
          // otherwise → omitted from JSON, byte-identical no-`--poc` summary).
          ...(result.pocAttemptedCount !== undefined
            ? {
                confirmedVerdictCount: result.confirmedVerdictCount ?? 0,
                pocExecutedVerdictCount: result.pocExecutedVerdictCount ?? 0,
                pocAttemptedCount: result.pocAttemptedCount,
                pocRanCount: result.pocRanCount ?? 0,
                pocSkippedInfraCount: result.pocSkippedInfraCount ?? 0,
              }
            : {}),
        },
        closure,
        result,
      };
    } catch (err) {
      return {
        outcome: {
          entry,
          status: "error",
          pursue: 0,
          drop: 0,
          findings: 0,
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        },
        closure: null,
        result: null,
      };
    }
  });
}
