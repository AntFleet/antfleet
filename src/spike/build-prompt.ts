// The exact prompt format used by the spike runner — and therefore the format
// the V2/V3 verdicts were computed against. Diverging from this means earlier
// empirical findings no longer apply to whatever consumer changes it. Pure
// function so both scripts/spike.ts and apps/web's review pipeline call into
// the same string.

export type PromptFile = { path: string; contents: string };

export type BuildSpikePromptArgs = {
  projectName: string;
  projectRoot: string;
  featureId: string;
  featureTitle: string;
  files: PromptFile[];
};

export function buildSpikePrompt(args: BuildSpikePromptArgs): string {
  const blocks = args.files.map((f) => `--- ${f.path}\n${f.contents}`);
  return `You are reviewing one semantic feature for fleet.

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
- maintainability risks with concrete impact

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
null when the bug is in the reviewed code itself. This field drives upstream PR targeting.

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
