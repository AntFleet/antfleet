// §3 wiring: A→B→C orchestration for the sidecar finder — POST-AUDIT REWORK.
// specs/SOLIDITY_SIDECAR_SPEC.md
//
// Promotion pipeline per REWORK_PROMPT: finder candidates are (1) mechanically
// citation-grounded (scoring.ts groundFinding — free, deterministic), then
// (2) attacked by the independent refuter pass (--live only; dry-run never
// promotes). PURSUE requires BOTH. Model booleans ride along as advisory
// metadata only.
//
// `callFinder` / `refute` are INJECTED so tests run with fakes. No network, no fs.

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
import { buildFinderPrompt, describeClosureHonesty } from "./prompt.js";
import type { HandledPayload } from "./model-client.js";

export type RunFinderInput = {
  projectName: string;
  entries: readonly string[];
  /** Closure blocks in keep-priority order (component A output). */
  files: readonly { path: string; contents: string }[];
  programRules: string;
  closureStats?: {
    truncated: boolean;
    evicted: readonly string[];
    externalUnresolved: readonly string[];
  };
};

export type FinderHandled = HandledPayload;

/** Injected adversarial-refutation callback. Production composes this from
 * buildRefuterPrompt + refuteModelCall (see scripts/audit-solidity.ts); tests
 * inject fakes. Receives everything needed to attack one finding. */
export type RefuteCallback = (args: {
  finding: AuditFinding;
  files: readonly { path: string; contents: string }[];
  programRules: string;
  contextNote: string;
}) => Promise<RefutationResult>;

export type ScoredFinding = {
  finding: AuditFinding;
  verdict: "PURSUE" | "DROP";
  reason: string;
  /** Advisory metadata from the finder model. Never gates promotion. */
  advisory: string;
};

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
};

/**
 * Dry-run = omit both callers: renders prompt + grounds citations (free) but
 * never promotes (grounded findings cap at "awaiting refuter" DROP).
 */
export async function runFinder(
  input: RunFinderInput,
  callFinder?: ((prompt: string) => Promise<FinderHandled>) | undefined,
  refute?: RefuteCallback | undefined,
): Promise<FinderRunResult> {
  const closureStats = input.closureStats ?? {
    truncated: false,
    evicted: [],
    externalUnresolved: [],
  };
  const contextNote = describeClosureHonesty({
    fileCount: input.files.length,
    bytes: input.files.reduce((sum, f) => sum + f.contents.length, 0),
    truncated: closureStats.truncated,
    evicted: closureStats.evicted,
    externalUnresolved: closureStats.externalUnresolved,
  });

  const prompt = buildFinderPrompt({
    projectName: input.projectName,
    entries: input.entries,
    files: input.files,
    programRules: input.programRules,
    contextNote,
  });

  const groundedFiles: GroundedFile[] = input.files.map((f) => ({
    path: f.path,
    contents: f.contents,
  }));

  if (callFinder === undefined) {
    return {
      prompt,
      findings: [],
      scored: [],
      pursueCount: 0,
      droppedCount: 0,
      rejectedRaw: [],
      truncated: false,
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
  const { findings, rejectedRaw } = lenientParseFindings(rawFindings);

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

  return {
    prompt,
    findings,
    scored,
    pursueCount: scored.filter((s) => s.verdict === "PURSUE").length,
    droppedCount: scored.filter((s) => s.verdict === "DROP").length,
    rejectedRaw,
    truncated: handled.truncated || refuterTruncated,
  };
}
