// The exact prompt format used by the spike runner — and therefore the format
// the V2/V3 verdicts were computed against. Diverging from this means earlier
// empirical findings no longer apply to whatever consumer changes it. Pure
// function so both scripts/spike.ts and apps/web's review pipeline call into
// the same string.

export type PromptFile = { path: string; contents: string };

// Cyber tier (Daybreak follow-up). When omitted or "default" the prompt
// is byte-identical to the legacy pre-cyber-tier output — important so
// existing empirical V2/V3 verdicts still apply on default-tier repos.
// When "cyber" a defender-context preamble is prepended that explicitly
// authorizes minimal PoC + reproduction technical detail; output is
// routed only through coordinated-disclosure private channels.
//
// Defense in depth: the visibility / finding-emit layer ALSO reads the
// cyber tier (apps/web/lib/cyber-tier.ts + lib/disclosure.ts). Neither
// path alone is sufficient — a misrouted prompt on a default-tier repo
// still gets default visibility; a misrouted visibility on a cyber-tier
// repo still gets default prompt.
export type CyberTier = "default" | "cyber";

export type BuildSpikePromptArgs = {
  projectName: string;
  projectRoot: string;
  featureId: string;
  featureTitle: string;
  files: PromptFile[];
  tier?: CyberTier;
};

const CYBER_TIER_PREAMBLE = `This review is operating under the AntFleet Cyber tier — the repo is operated
by a verified defender on a sensitive system, and your output is routed only
through coordinated-disclosure private channels (never published). For each
finding, include a minimal proof-of-concept and reproduction path sufficient
for the maintainer to reproduce the issue against a known commit. Do not
withhold technical detail required to make the finding actionable. You are
still bound by the rule that findings must be evidence-driven — do not invent
vulnerabilities to satisfy the brief.

`;

export function buildSpikePrompt(args: BuildSpikePromptArgs): string {
  const cyberPrefix = args.tier === "cyber" ? CYBER_TIER_PREAMBLE : "";
  const blocks = args.files.map((f) => `--- ${f.path}\n${f.contents}`);
  // Smart-contract supplement, conditional on Solidity in the bundle. Ports
  // the soft category-list pattern from open-evmbench's antfleet_reference
  // consensus_agent.py AUDITOR_PROMPT verbatim — the actual source lists
  // "logic errors, access control, reentrancy, oracle misuse, accounting
  // errors, etc" as smart-contract-shaped vulnerabilities. Advisory, not a
  // forced output template — the model still emits findings under the
  // existing top-level "category" enum.
  const solSupplement = args.files.some((f) => f.path.toLowerCase().endsWith(".sol"))
    ? `

Smart contract supplement (Solidity files present in this bundle — consider
these categories alongside the ones above where they apply):
- logic errors (state machine, share/asset accounting, invariant violations)
- access control and privilege escalation
- reentrancy and external-call ordering
- oracle misuse (price manipulation, stale data, single-source trust)
- accounting errors (rounding bias, fee math, over/underflow)`
    : "";
  return `${cyberPrefix}You are reviewing one semantic feature for fleet.

Return strict JSON only. No markdown fences.

Project:
${JSON.stringify({ name: args.projectName, root: args.projectRoot }, null, 2)}

Feature:
${JSON.stringify(
  {
    featureId: args.featureId,
    title: args.featureTitle,
    kind: "library",
    ownedFiles: args.files.map((f) => ({ path: f.path, reason: "owned" })),
  },
  null,
  2,
)}

Review categories:
- correctness bugs (null derefs, off-by-one, wrong branch)
- security issues (injection, missing auth, unsafe deserialization)
- race/concurrency bugs (TOCTOU, read-modify-write, shared mutation)
- data loss/corruption
- bad error handling
- API contract gaps (missing validation, unchecked input)
- deceptive or misleading comments/docs
- maintainability risks with concrete impact${solSupplement}

Inspect every file. Treat suspicious comments as evidence to verify against the
code they describe; a comment that lies about behavior is itself a bug.

Avoid speculative low-evidence findings. Evidence MUST point at the file:line
ranges you actually inspected.

Policy context: when a finding's severity hinges on whether the behavior is intentional design
rather than a bug — e.g. a limit that can be exceeded but may be a documented feature, or an
auth bypass that might be an explicitly granted escape hatch — set requiresPolicyReview to true.
Cap severity at "medium" when requiresPolicyReview is true. Do not guess; if you cannot determine
from the code and comments in front of you whether this is a bug or a feature, set this flag.

Upstream origin: when a finding's root cause traces to an imported external dependency (npm
package, upstream smart contract, third-party SDK) rather than code in the reviewed files, set
upstreamOrigin to {"package":"<package-name>","reason":"<why the bug is in the dep>"}. Set it to
null when the bug is in the reviewed code itself. This field is collected to inform upstream PR targeting.

JSON shape:
{
  "findings": [
    {
      "title": "string",
      "category": "bug|security|performance|concurrency|api-contract|data-loss|test-gap|docs-gap|build-release|maintainability",
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "evidence": [{"path":"string","startLine":1,"endLine":1,"symbol":null,"quote":null}],
      "reasoning": "string",
      "reproduction": null,
      "recommendation": "string",
      "whyTestsDoNotAlreadyCoverThis": "string",
      "suggestedRegressionTest": "string or null",
      "minimumFixScope": "string",
      "requiresPolicyReview": false,
      "upstreamOrigin": null
    }
  ],
  "inspected": {"files":["string"],"symbols":["string"],"notes":["string"]}
}

Files:
${blocks.join("\n\n")}`;
}
