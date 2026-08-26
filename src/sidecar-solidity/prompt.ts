// Hand-prototyped full-contract AUDIT prompt for the Solidity kill-test
// (specs/SOLIDITY_AUDIT_MODE_SPEC.md §2 step 2 — "a scratch prompt, no wiring").
//
// This is deliberately NOT the PR-review prompt (src/spike/build-prompt.ts).
// Per spec §1/§3, the new mode changes the objective from "find bugs in this
// slice" to: ingest the whole contract + closure, hunt unprivileged
// fund-extraction / permanent-freeze paths, and score each candidate against
// the target program's severity/scope/recovery rules.
//
// The model emits the four program-rule FACTORS; PURSUE/DROP verdicts are
// computed deterministically in code (see scoring.ts) rather than trusted from
// the model — a hand-prototype must keep the scoring falsifiable.

export type AuditPromptFile = { path: string; contents: string };

export type BuildAuditPromptArgs = {
  projectName: string;
  /** Entry contracts of this audit unit (the contracts that custody/move funds). */
  entryContracts: readonly string[];
  /** Whole contract + dependency-closure files (Mode-A context, uncapped). */
  files: readonly AuditPromptFile[];
  /**
   * The target program's real inputs: severity definitions, out-of-scope list,
   * measures/recovery policy (e.g. team pause/upgrade → 1-hour damage cap),
   * prior-audit notes. Free text assembled by the operator.
   */
  programRules: string;
};

export const AUDIT_JSON_SHAPE = `{
  "findings": [
    {
      "title": "string",
      "category": "security|bug|data-loss",
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "evidence": [{"path":"string","startLine":1,"endLine":1,"symbol":null,"quote":null}],
      "reasoning": "string — the full value-flow trace: who calls what, where funds move, why they are extractable or freezable",
      "triggerRole": "who can trigger this path (e.g. 'any unprivileged EOA', 'onlyRole(PAUSER)')",
      "preconditions": "state/external conditions required before the path is live",
      "unprivilegedReachable": true|false,
      "recoverableUnder1hr": true|false,
      "inScope": true|false,
      "duplicateOf": null | "short id/description of a known prior audit finding if you believe this is already public"
    }
  ],
  "inspected": {"files":["string"],"notes":["string"]}
}`;

export function buildFullContractAuditPrompt(args: BuildAuditPromptArgs): string {
  const blocks = args.files.map((f) => `--- ${f.path}\n${f.contents}`);
  return `You are performing a full-codebase smart-contract audit for a bug-bounty target.
The review unit below is the COMPLETE target contract plus its dependency
closure (inheritance chain, called libraries/interfaces, tightly-coupled
siblings). There is no diff — audit the deployed behavior as a whole.

Project:
${JSON.stringify({ name: args.projectName }, null, 2)}

Entry contracts (custody or move protocol funds):
${JSON.stringify(args.entryContracts, null, 2)}

OBJECTIVE — fund extraction and permanent freeze, nothing else:
1. Trace value flow through the contract system. Identify every path that moves
   funds OUT of the protocol or PERMANENTLY freezes them.
2. For each path, state who can trigger it and under what preconditions.
3. Flag paths reachable WITHOUT a privileged role as top priority.
4. Local anomalies (a revert nobody reaches, rounding dust with no extraction
   path) are only reportable if they map to a concrete fund-loss/freeze path.

PROGRAM RULES — score every candidate against these:
${args.programRules.trim()}

For every finding you emit, fill in the program-rule factors honestly against
those rules. Do not inflate: unprivilegedReachable=false or
recoverableUnder1hr=true will DROP the candidate at scoring time.

Evidence MUST point at file:line ranges in the files shown below.

Return strict JSON only. No markdown fences.

JSON shape:
${AUDIT_JSON_SHAPE}

Files:
${blocks.join("\n\n")}`;
}

// --- Sidecar finder prompt (specs/SOLIDITY_SIDECAR_SPEC.md §3-B) -------------
// Neutral, target-agnostic objective. ANTI-CONTAMINATION (hard rule): this
// scaffold must never name, hint at, or structurally describe a specific bug,
// attack chain, or known finding for any target. The only target-derived text
// in the rendered prompt is (a) entry paths, (b) closure file blocks, and
// (c) the operator-supplied program rules, all clearly delimited below.

export type FinderPromptArgs = {
  projectName: string;
  entries: readonly string[];
  /** Closure blocks in keep-priority order (from assembleClosure). */
  files: readonly { path: string; contents: string }[];
  /** Operator-supplied program rules: severity defs, scope exclusions, recovery policy. */
  programRules: string;
  /** Closure assembly stats surfaced to the model + report. */
  contextNote?: string | undefined;
};

export function buildFinderPrompt(args: FinderPromptArgs): string {
  const blocks = args.files.map((f) => `--- ${f.path}\n${f.contents}`);
  return `You are auditing a smart-contract system as a whole. The material below is the
complete dependency closure of the target contracts — inheritance bases,
libraries, interfaces, and related contracts that create or are created by them.
There is no diff; audit deployed behavior across file boundaries.

Project: ${args.projectName}
Entry contracts:
${args.entries.map((e) => `- ${e}`).join("\n")}
${args.contextNote === undefined ? "" : `\nContext note: ${args.contextNote}\n`}
OBJECTIVE — enumerate, exhaustively, every way an actor WITHOUT privileged access
can extract funds held by the system or permanently freeze them. Work through
these domains and check each against the actual code:

1. Deployment and initialization (constructor/initializer ordering, who can
   deploy what with which parameters, front-running of setup)
2. Authorization and signature checks (who may call value-moving functions;
   signature replay/malleability; role assumptions)
3. Accounting (shares/assets math, fee and reward accounting, rounding,
   cross-contract balance assumptions)
4. Execution and external calls (reentrancy and call ordering, token-behavior
   assumptions, oracle inputs)
5. Cross-contract trust (assumptions between contracts about each other's state,
   addresses, and configuration)

For each candidate finding, provide file + line-range evidence from the files
below, the trigger role (who can invoke it), and required preconditions.

PROGRAM RULES — score every candidate against these rules verbatim:
${args.programRules.trim()}

Fill the program-rule factors honestly. unprivilegedReachable=false or
recoverableUnder1hr=true will DROP the candidate at scoring time. Evidence MUST
point at line ranges in the files shown below. Return strict JSON only, no
markdown fences.

JSON shape:
${AUDIT_JSON_SHAPE}

Files:
${blocks.join("\n\n")}`;
}
