// §3 wiring: pure A→B→C orchestration for the sidecar finder.
// specs/SOLIDITY_SIDECAR_SPEC.md
//
// `callModel` is INJECTED so tests run with a fake and the CLI's dry-run mode
// simply never provides one. No network, no fs here.

import { auditOutputSchema, scoreAuditFinding, type AuditFinding } from "./killtest.js";
import { buildFinderPrompt } from "./prompt.js";

export type RunFinderInput = {
  projectName: string;
  entries: readonly string[];
  /** Closure blocks in keep-priority order (component A output). */
  files: readonly { path: string; contents: string }[];
  programRules: string;
  contextNote?: string;
};

export type ScoredFinding = {
  finding: AuditFinding;
  verdict: "PURSUE" | "DROP";
  reason: string;
};

export type FinderRunResult = {
  prompt: string;
  findings: AuditFinding[];
  scored: ScoredFinding[];
  pursueCount: number;
  droppedCount: number;
};

/**
 * Render the prompt (B) from the assembled closure (A), and — when callModel is
 * provided — execute it, leniently parse the output, and score every finding
 * through the unchanged program-rule scorer (C).
 *
 * DRY-RUN = pass callModel === undefined: you get the rendered prompt back with
 * zero model interaction.
 */
export async function runFinder(
  input: RunFinderInput,
  callModel?: ((prompt: string) => Promise<unknown>) | undefined,
): Promise<FinderRunResult> {
  const prompt = buildFinderPrompt({
    projectName: input.projectName,
    entries: input.entries,
    files: input.files,
    programRules: input.programRules,
    contextNote: input.contextNote,
  });

  if (callModel === undefined) {
    return {
      prompt,
      findings: [],
      scored: [],
      pursueCount: 0,
      droppedCount: 0,
    };
  }

  const raw = await callModel(prompt);
  const parsed = auditOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`finder output failed lenient parse: ${parsed.error.message}`);
  }
  const findings = parsed.data.findings;
  const scored = findings.map((finding) => {
    const verdict = scoreAuditFinding(finding);
    return { finding, verdict: verdict.verdict, reason: verdict.reason };
  });
  return {
    prompt,
    findings,
    scored,
    pursueCount: scored.filter((s) => s.verdict === "PURSUE").length,
    droppedCount: scored.filter((s) => s.verdict === "DROP").length,
  };
}
