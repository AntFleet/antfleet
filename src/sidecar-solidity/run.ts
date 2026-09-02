// §3 wiring: A→B→C orchestration for the sidecar finder — POST-AUDIT REWORK +
// CLOSURE_UPGRADE item 2 (two-stage finder).
//
// Promotion pipeline: candidates are (1) mechanically citation-grounded
// (scoring.ts groundFinding — free, deterministic), then (2) attacked by the
// independent refuter pass (--live only; dry-run never promotes). PURSUE
// requires BOTH. Model booleans ride along as advisory metadata only.
//
// TWO-STAGE FINDER (CLOSURE_UPGRADE 2.1): Monetrix proved presence ≠ attention
// — the audit arm HAD the deciding file and still skimmed past its bug. When a
// `confirm` callback is injected (--live), runFinder runs:
//   Stage A (slice): entry files ONLY → candidate findings + explicit
//     `crossFileDependencies` ("I need to see X's source to settle this").
//   Stage B (confirm): ONE focused pass per candidate over exactly the
//     candidate's own files + the named siblings — never the whole closure —
//     completing/refuting each chain before scoring.
// Without `confirm` the classic single-pass whole-closure prompt is used.

import {
  lenientParseFindings,
  type AuditFinding,
  type RejectedFindingRecord,
} from "./finding-schema.js";
import {
  advisorySummary,
  groundFinding,
  promote,
  type GroundedFile,
  type RefutationResult,
} from "./scoring.js";
import {
  buildFocusedConfirmPrompt,
  buildFinderPrompt,
  buildSlicePrompt,
  describeClosureHonesty,
} from "./prompt.js";
import {
  parseClosureFile,
  resolvePocTarget,
  staticGatePoc,
  promoteWithPoc,
  CANDIDATE_LABEL,
  CONFIRMED_LABEL,
  POC_EXECUTED_LABEL,
  NON_TERMINAL_POC_LABEL,
  type ActiveGo,
  type ClosureAst,
  type PocExecution,
  type PocRecord,
  type PocTarget,
} from "./poc.js";
import type { PocGenerationOutput } from "./poc-prompt.js";
import type { HandledPayload } from "./model-client.js";

export type RunFinderInput = {
  projectName: string;
  entries: readonly string[];
  /** Closure blocks in keep-priority order (component A output). */
  files: readonly { path: string; contents: string }[];
  programRules: string;
  /** Foundry remappings (specifier → path) — used ONLY by the PoC stage's §3.3.A
   * real-dependency anchor to resolve vendored-scaffolding imports to lib/
   * node_modules paths. Unused when --poc is off (byte-identical preserved). */
  remappings?: readonly (readonly [string, string])[] | undefined;
  /** Phase 0 DESCRIPTIVE system context (docs/NatSpec) for the finder. Recall-safe. */
  systemContext?: string | undefined;
  closureStats?: {
    truncated: boolean;
    evicted: readonly string[];
    externalUnresolved: readonly string[];
    unresolvedEdges?: readonly string[];
  };
};

export type FinderHandled = HandledPayload;

/** Injected adversarial-refutation callback. Production composes this from
 * buildRefuterPrompt + refuteModelCall (see src/sidecar-solidity/cli.ts); tests
 * inject fakes. Receives everything needed to attack one finding. */
export type RefuteCallback = (args: {
  finding: AuditFinding;
  files: readonly { path: string; contents: string }[];
  programRules: string;
  contextNote: string;
}) => Promise<RefutationResult>;

/**
 * Injected focused-confirm callback (stage B). Production composes this from
 * buildFocusedConfirmPrompt + confirmModelCall (gpt-5.5); --live only. Receives the
 * candidate and ONLY its focused context; returns refined findings for it.
 */
export type ConfirmCallback = (args: {
  finding: AuditFinding;
  /** Entry file(s) involved + exactly the named siblings. */
  focusedFiles: readonly { path: string; contents: string }[];
  programRules: string;
}) => Promise<FinderHandled>;

/** One suspected cross-file dependency named by the stage-A pass. */
export type CrossFileDependency = { symbol: string; reason: string };

export type ScoredFinding = {
  finding: AuditFinding;
  /** CONFIRMED (Tier-1) and POC_EXECUTED (Tier-2) are reachable ONLY from PURSUE
   * via promoteWithPoc after execution + a valid GO (Phase 3). In the
   * generation-only tier neither appears. */
  verdict: "CONFIRMED" | "POC_EXECUTED" | "PURSUE" | "DROP";
  reason: string;
  /** Advisory metadata from the finder model. Never gates promotion. */
  advisory: string;
  /** Post-PURSUE PoC record — present only when the --poc stage ran (§3.1). */
  poc?: PocRecord;
};

/** Injected PoC generation callback (--poc). Production composes this from
 * buildPocGenerationPrompt + pocModelCall (sweep.ts). Receives the resolved
 * target + focused files; returns the model's generation output. */
export type GeneratePocCallback = (args: {
  finding: AuditFinding;
  pocTarget: PocTarget;
  files: readonly { path: string; contents: string }[];
  programRules: string;
}) => Promise<PocGenerationOutput>;

/** Injected PoC execution callback. UNSET in Phase 1 (executor is Phase 3, gated
 * behind the §7 spike) — so the terminal tiers are unreachable until it is wired.
 * `binding` is set for the static-bound tier; `harnessDriveSpan` for the
 * harness-driven tier (§3.4). */
export type ExecutePocCallback = (args: {
  testContents: string;
  binding: NonNullable<ReturnType<typeof staticGatePoc>["binding"]> | undefined;
  harnessDriveSpan: NonNullable<ReturnType<typeof staticGatePoc>["harnessDriveSpan"]> | undefined;
  pocTarget: PocTarget;
}) => Promise<PocExecution>;

export type FinderRunResult = {
  prompt: string;
  findings: AuditFinding[];
  scored: ScoredFinding[];
  pursueCount: number;
  droppedCount: number;
  /** Raw rejected findings preserved for inspection (never silently discarded). */
  rejectedRaw: RejectedFindingRecord[];
  /** True when stop_reason was max_tokens on ANY live call — run is INCOMPLETE. */
  truncated: boolean;
  /**
   * Two-stage bookkeeping: dependencies the slice pass asked for, and which of
   * them resolved into the focused passes. Empty in single-pass mode.
   */
  crossFileDependencies: CrossFileDependency[];
  resolvedDependencies: string[];
  focusedPrompts: string[];
  /** PoC-stage counters — UNDEFINED (omitted from JSON) when --poc is off, so a
   * no-`--poc` run is byte-identical to today (§3.1). Canonical names (§3.1/§4):
   * "got the verdict" (`*VerdictCount`) is never confused with "was run"
   * (`pocRanCount`). */
  confirmedVerdictCount?: number;
  pocExecutedVerdictCount?: number;
  pocAttemptedCount?: number;
  pocRanCount?: number;
  pocSkippedInfraCount?: number;
};

const DECLARATION_AT_REGEX = /\b(?:abstract\s+)?(?:contract|interface|library)\s+SYMBOL\b/u;

function blockDeclaresSymbol(contents: string, symbol: string): boolean {
  return new RegExp(
    DECLARATION_AT_REGEX.source.replace("SYMBOL", symbol.replace(/\$/gu, "\\$")),
  ).test(contents);
}

/**
 * Models rarely return a bare symbol — real stage-A output names deps like
 * "SmartAccountFactory / Proxy deployment path" or "Executor (base of
 * ModuleManager)". Pull out the declaration-name candidates (PascalCase-ish
 * identifiers), longest first so the most specific contract name wins over an
 * incidental short token.
 */
export function identifierCandidates(symbol: string): string[] {
  const tokens = symbol.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    // A Solidity declaration name starts uppercase; skip prose words / short noise.
    if (!/^[A-Z]/u.test(t) || t.length < 3 || seen.has(t)) {
      continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out.toSorted((a, b) => b.length - a.length);
}

function extractCrossFileDependencies(payload: HandledPayload): CrossFileDependency[] {
  const raw =
    payload.payload !== null &&
    typeof payload.payload === "object" &&
    (payload.payload as Record<string, unknown>)["crossFileDependencies"]
      ? ((payload.payload as Record<string, unknown>)["crossFileDependencies"] as unknown[])
      : [];
  const out: CrossFileDependency[] = [];
  for (const entry of raw) {
    if (entry !== null && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const symbol = typeof rec["symbol"] === "string" ? rec["symbol"].trim() : "";
      if (symbol.length === 0) {
        continue;
      }
      out.push({
        symbol,
        reason: typeof rec["reason"] === "string" ? rec["reason"] : "",
      });
    }
  }
  return out;
}

/**
 * Resolve named dependency symbols to the SMALLEST set of closure blocks that
 * declare them. Unresolvable names are returned so callers can surface them —
 * an unfound sibling must not silently vanish.
 */
export function resolveNamedSiblings(
  deps: readonly CrossFileDependency[],
  closureFiles: readonly { path: string; contents: string }[],
): {
  focused: { path: string; contents: string }[];
  unresolved: string[];
  resolvedSymbols: string[];
} {
  const focused: { path: string; contents: string }[] = [];
  const taken = new Set<string>();
  const unresolved: string[] = [];
  const resolvedSymbols: string[] = [];
  for (const dep of deps) {
    // Try the bare symbol first, then each PascalCase identifier extracted from a
    // prose-y dependency string ("SmartAccountFactory / Proxy deployment path").
    const candidates = [dep.symbol, ...identifierCandidates(dep.symbol)];
    let hit: { path: string; contents: string } | undefined;
    for (const candidate of candidates) {
      hit = closureFiles.find(
        (f) => !taken.has(f.path) && blockDeclaresSymbol(f.contents, candidate),
      );
      if (hit !== undefined) {
        break;
      }
    }
    if (hit === undefined) {
      unresolved.push(dep.symbol);
      continue;
    }
    taken.add(hit.path);
    focused.push(hit);
    resolvedSymbols.push(dep.symbol);
  }
  return { focused, unresolved, resolvedSymbols };
}

/**
 * Dry-run = omit all callers: renders prompts + grounds citations (free) but
 * never promotes (grounded findings cap at "awaiting refuter" DROP).
 *
 * With `confirm` injected (--live), runs the two-stage finder: stage A sees
 * only ENTRY files; each grounded candidate that names missing definitions gets
 * ONE focused pass over exactly its own evidence files plus those siblings.
 */
export async function runFinder(
  input: RunFinderInput,
  callFinder?: ((prompt: string) => Promise<FinderHandled>) | undefined,
  refute?: RefuteCallback | undefined,
  confirm?: ConfirmCallback | undefined,
  generatePoc?: GeneratePocCallback | undefined,
  executePoc?: ExecutePocCallback | undefined,
  activeGo?: ActiveGo | undefined,
): Promise<FinderRunResult> {
  const closureStats = input.closureStats ?? {
    truncated: false,
    evicted: [],
    externalUnresolved: [],
    unresolvedEdges: [],
  };
  const contextNote = describeClosureHonesty({
    fileCount: input.files.length,
    bytes: input.files.reduce((sum, f) => sum + f.contents.length, 0),
    truncated: closureStats.truncated,
    evicted: closureStats.evicted,
    externalUnresolved: closureStats.externalUnresolved,
    unresolvedEdges: closureStats.unresolvedEdges,
  });

  const groundedFiles: GroundedFile[] = input.files.map((f) => ({
    path: f.path,
    contents: f.contents,
  }));

  const twoStage =
    confirm !== undefined && input.files.some((f) => !input.entries.includes(f.path));

  // --- Stage A prompt ---------------------------------------------------------
  // Two-stage: entry files only. Single-pass: full closure dump (unchanged
  // behavior for callers without a confirm lane).
  const stageAFiles = twoStage
    ? input.files.filter((f) => input.entries.includes(f.path))
    : input.files;
  const prompt = twoStage
    ? buildSlicePrompt({
        projectName: input.projectName,
        entries: input.entries,
        files: stageAFiles,
        programRules: input.programRules,
        contextNote,
        systemContext: input.systemContext,
      })
    : buildFinderPrompt({
        projectName: input.projectName,
        entries: input.entries,
        files: input.files,
        programRules: input.programRules,
        contextNote,
        systemContext: input.systemContext,
      });

  if (callFinder === undefined) {
    return {
      prompt,
      findings: [],
      scored: [],
      pursueCount: 0,
      droppedCount: 0,
      rejectedRaw: [],
      truncated: false,
      crossFileDependencies: [],
      resolvedDependencies: [],
      focusedPrompts: [],
    };
  }

  const handled = await callFinder(prompt);
  const rawObj = handled.payload;
  const rawFindings =
    rawObj !== null &&
    typeof rawObj === "object" &&
    Array.isArray((rawObj as Record<string, unknown>)["findings"])
      ? ((rawObj as Record<string, unknown>)["findings"] as unknown[])
      : undefined;
  if (rawFindings === undefined) {
    throw new Error(
      "finder output has no findings array — refusing to score a structurally broken response as zero findings",
    );
  }
  let { findings, rejectedRaw } = lenientParseFindings(rawFindings);

  // --- Stage B: focused confirm passes ----------------------------------------
  const focusedPrompts: string[] = [];
  let resolvedDeps: string[] = [];
  if (twoStage && confirm !== undefined) {
    const deps = extractCrossFileDependencies(handled);
    const { focused, unresolved, resolvedSymbols } = resolveNamedSiblings(deps, input.files);
    resolvedDeps = resolvedSymbols;
    if (deps.length > 0) {
      console.error(
        `[run-finder] stage A named ${deps.length} cross-file dependency(ies); ` +
          `${resolvedDeps.length} resolved into focused context${unresolved.length > 0 ? `; UNRESOLVED (named but not in closure): ${unresolved.join(", ")}` : ""}`,
      );
    }
    if (focused.length > 0) {
      const refined: AuditFinding[] = [];
      for (const finding of findings) {
        const evidencePaths = new Set(
          finding.evidence.map((e) => e.path).filter((p): p is string => p !== null),
        );
        const focusedFiles = [
          ...input.files.filter((f) => evidencePaths.has(f.path) || input.entries.includes(f.path)),
          ...focused.filter((f) => !evidencePaths.has(f.path)),
        ];
        const confirmPrompt = buildFocusedConfirmPrompt({
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
          programRules: input.programRules,
          systemContext: input.systemContext,
        });
        focusedPrompts.push(confirmPrompt);
        const confirmHandled = await confirm({
          finding,
          focusedFiles,
          programRules: input.programRules,
        });
        const cRaw = confirmHandled.payload as Record<string, unknown> | null;
        const cList =
          cRaw !== null && typeof cRaw === "object" && Array.isArray(cRaw["findings"])
            ? (cRaw["findings"] as unknown[])
            : [];
        if (cList.length > 0) {
          // The refined findings REPLACE the candidate they came from — the
          // completed/revised chain supersedes the half-seen original.
          refined.push(...lenientParseFindings(cList).findings);
        } else {
          refined.push(finding); // empty confirm response keeps the original
        }
      }
      findings = refined;
    }
  }

  const scored: ScoredFinding[] = [];
  let refuterTruncated = false;
  for (const finding of findings) {
    const grounding = groundFinding(finding, groundedFiles);
    let refutation: RefutationResult | null = null;
    if (grounding.ok && refute !== undefined) {
      // Spend refuter calls only on candidates that survived grounding.
      refutation = await refute({
        finding,
        files: input.files,
        programRules: input.programRules,
        contextNote,
      });
    }
    const decision = promote({ grounding, refutation });
    scored.push({
      finding,
      verdict: decision.verdict,
      reason: decision.reason,
      advisory: advisorySummary(finding),
    });
  }

  // --- Post-PURSUE PoC stage (§3.3/§4) — strictly opt-in via `generatePoc` ----
  // Runs only on PURSUE findings; never demotes to DROP. In the generation-only
  // tier (`executePoc` unset — Phase 1) findings stay PURSUE with a CANDIDATE PoC.
  const pocCounters = { attempted: 0, executed: 0, skippedInfra: 0 };
  if (generatePoc !== undefined) {
    const closureAstByPath = buildClosureAstMap(input.files);
    for (const s of scored) {
      if (s.verdict !== "PURSUE") {
        continue;
      }
      pocCounters.attempted += 1;
      s.poc = await runPocStage({
        finding: s.finding,
        entries: input.entries,
        files: input.files,
        programRules: input.programRules,
        remappings: input.remappings ?? [],
        closureAstByPath,
        generatePoc,
        executePoc,
        onExecuted: () => (pocCounters.executed += 1),
        onSkippedInfra: () => (pocCounters.skippedInfra += 1),
      });
      const promoted = promoteWithPoc({
        base: { verdict: "PURSUE", reason: s.reason },
        poc: s.poc,
        execution: s.poc.execution,
        activeGo,
      });
      s.verdict = promoted.verdict;
      s.reason = promoted.reason;
      // Co-carry the atomic §1 caveat label in the serialized record (§3.1), so a
      // JSON consumer keying on verdict also sees the honest tier caveat beside it.
      if (s.poc.generated) {
        s.poc.label =
          s.verdict === "CONFIRMED"
            ? CONFIRMED_LABEL
            : s.verdict === "POC_EXECUTED"
              ? POC_EXECUTED_LABEL
              : s.poc.executed
                ? NON_TERMINAL_POC_LABEL // executed but not promoted (tier-not-enabled / no-revert)
                : CANDIDATE_LABEL; // generation-only (Phase 1)
      }
    }
  }

  return {
    prompt,
    findings,
    scored,
    pursueCount: scored.filter((s) => s.verdict === "PURSUE").length,
    droppedCount: scored.filter((s) => s.verdict === "DROP").length,
    rejectedRaw,
    truncated: handled.truncated || refuterTruncated,
    crossFileDependencies: twoStage ? extractCrossFileDependencies(handled) : [],
    resolvedDependencies: resolvedDeps,
    focusedPrompts,
    ...(generatePoc !== undefined
      ? {
          confirmedVerdictCount: scored.filter((s) => s.verdict === "CONFIRMED").length,
          pocExecutedVerdictCount: scored.filter((s) => s.verdict === "POC_EXECUTED").length,
          pocAttemptedCount: pocCounters.attempted,
          pocRanCount: pocCounters.executed,
          pocSkippedInfraCount: pocCounters.skippedInfra,
        }
      : {}),
  };
}

// --- PoC stage helpers -------------------------------------------------------

/** Parse the closure blocks into a canonical-path-keyed AST map (once per run). */
function buildClosureAstMap(
  files: readonly { path: string; contents: string }[],
): Map<string, ClosureAst> {
  const map = new Map<string, ClosureAst>();
  for (const f of files) {
    const ast = parseClosureFile(f.path, f.contents);
    if (ast !== null) {
      map.set(f.path, ast);
    }
  }
  return map;
}

function pocSlug(title: string): string {
  const s = title
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return s.length > 0 ? s : "finding";
}

/**
 * Run the PoC stage for ONE PURSUE finding: resolve the target → generate →
 * static-gate → (execute if an executor is wired) → PocRecord. Never throws — a
 * failure at any step becomes a record that keeps the finding PURSUE.
 */
async function runPocStage(args: {
  finding: AuditFinding;
  entries: readonly string[];
  files: readonly { path: string; contents: string }[];
  programRules: string;
  remappings: readonly (readonly [string, string])[];
  closureAstByPath: Map<string, ClosureAst>;
  generatePoc: GeneratePocCallback;
  executePoc?: ExecutePocCallback | undefined;
  onExecuted: () => void;
  onSkippedInfra: () => void;
}): Promise<PocRecord> {
  const base: PocRecord = {
    generated: false,
    rationale: null,
    tier: null,
    assertionForm: null,
    label: null,
    target: null,
    binding: null,
    harnessDriveSpan: null,
    testPath: null,
    testContents: null,
    staticGate: { passed: false, reasons: [] },
    executed: false,
    execution: null,
    humanGated: true,
    runSpecific: true,
  };
  try {
    const target = resolvePocTarget(args.finding, { entries: args.entries }, args.closureAstByPath);
    if (target === null) {
      return { ...base, rationale: "no unique concrete deployable target for cited evidence" };
    }
    const evidencePaths = new Set(
      args.finding.evidence.map((e) => e.path).filter((p): p is string => p !== null),
    );
    const focused = args.files.filter((f) => f.path === target.path || evidencePaths.has(f.path));
    const files = focused.length > 0 ? focused : args.files;
    const out = await args.generatePoc({
      finding: args.finding,
      pocTarget: target,
      files,
      programRules: args.programRules,
    });
    if (out.testContents === null) {
      return { ...base, target, rationale: out.rationale ?? "model declined without a rationale" };
    }
    const gate = staticGatePoc(
      out.testContents,
      args.finding,
      target,
      args.closureAstByPath,
      args.remappings,
    );
    const testPath = `test/AuditPoc_${pocSlug(args.finding.title)}.t.sol`;
    if (!gate.passed || gate.tier === undefined) {
      return {
        ...base,
        generated: true,
        target,
        testPath,
        testContents: out.testContents,
        staticGate: { passed: false, reasons: gate.reasons },
      };
    }
    const gatedBase = {
      ...base,
      generated: true,
      target,
      testPath,
      testContents: out.testContents,
      tier: gate.tier,
      assertionForm: gate.assertionForm ?? null,
      binding: gate.binding ?? null,
      harnessDriveSpan: gate.harnessDriveSpan ?? null,
      staticGate: { passed: true, reasons: [] },
    };
    if (args.executePoc === undefined) {
      args.onSkippedInfra(); // executor off (Phase 1): CANDIDATE only, stays PURSUE
      return { ...gatedBase, label: CANDIDATE_LABEL };
    }
    let execution: PocExecution;
    try {
      execution = await args.executePoc({
        testContents: out.testContents,
        binding: gate.binding,
        harnessDriveSpan: gate.harnessDriveSpan,
        pocTarget: target,
      });
    } catch (execErr) {
      // An executor THROW is an INFRA skip, not a generation failure: count it as
      // skipped-infra and PRESERVE the gated candidate record (target, testContents,
      // static gate) rather than collapsing to the empty "generation failed" base.
      args.onSkippedInfra();
      return {
        ...gatedBase,
        executed: false,
        label: CANDIDATE_LABEL,
        rationale: `executor error: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
      };
    }
    // An infra/gating skip (deps unavailable, GO missing) returns executed:false
    // and never promotes — count it as skipped, not run (§3.4).
    if (!execution.executed) {
      args.onSkippedInfra();
      return { ...gatedBase, executed: false, execution, label: CANDIDATE_LABEL };
    }
    args.onExecuted();
    return { ...gatedBase, executed: true, execution };
  } catch (err) {
    return {
      ...base,
      rationale: `generation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
