import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { FleetConfig, FeatureRecord, FindingRecord, ProjectRecord } from "./types.js";

export async function buildReviewPrompt(
  root: string,
  project: ProjectRecord,
  feature: FeatureRecord,
  config: FleetConfig,
): Promise<string> {
  const owned = feature.ownedFiles.slice(0, config.review.maxOwnedFiles);
  const context = feature.contextFiles.slice(0, config.review.maxContextFiles);
  const fileBlocks: string[] = [];
  for (const ref of [...owned, ...context]) {
    fileBlocks.push(await fileBlock(root, ref.path));
  }
  return `You are reviewing one semantic feature for fleet.

Return strict JSON only. No markdown fences.

Project:
${JSON.stringify({ name: project.name, detected: project.detected }, null, 2)}

Feature:
${JSON.stringify(feature, null, 2)}

Review categories:
- correctness bugs
- security issues
- race/concurrency bugs
- data loss/corruption
- resource leaks
- bad error handling
- permission/auth gaps
- API contract mismatches
- missing/weak tests
- release/build hazards
- maintainability risks with concrete impact

Inspect owned files, context files, and linked tests. Treat included tests as first-class
evidence of intended behavior. If tests contradict a suspected bug, either skip it or
downgrade confidence and explain the uncertainty. Avoid reporting behavior as a bug
solely because a helper name implies a broader contract. Deduplicate sibling/root-cause
issues: when the same bug pattern appears in multiple owned files, emit one finding
with multiple evidence refs instead of separate one-off findings.

Avoid speculative low-evidence findings. Evidence must point at included files.

Posting bar: only emit a finding if NOT posting it would let code health regress. Polish-grade
observations, stylistic preferences, and speculative future risks fail this bar — drop them
silently. This review feeds a two-model unanimous gate where every posted finding is treated as
blocking; reserve emission for findings that meet that bar.

Label rules (required field):
- "blocking"  — finding must be addressed before merge; anything critical/high defaults here
- "nit"       — minor issue; real but not merge-blocking (prefix your recommendation with "Nit:")
- "optional"  — improvement worth considering but genuinely optional
- "fyi"       — informational only; no action expected

When severity is critical or high, label must be "blocking".
When category is docs-gap or maintainability and severity is low, prefer "nit" or "optional".

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
      "label": "blocking|nit|optional|fyi",
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
${fileBlocks.join("\n\n")}`;
}

export async function buildRevalidatePrompt(root: string, findingJson: string): Promise<string> {
  return `Revalidate this fleet finding against the current repository at ${root}.

Check whether the original evidence paths/lines still exist. If evidence moved or changed,
decide whether the issue is fixed, stale/false-positive, still open elsewhere, or uncertain.
Use tests and current code as evidence; do not assume a missing line means fixed.

Return strict JSON only:
{"outcome":"fixed|open|false-positive|uncertain","reasoning":"string","commands":["string"]}

Finding:
${findingJson}`;
}

export async function buildFixPrompt(
  root: string,
  finding: FindingRecord,
  feature: FeatureRecord,
): Promise<string> {
  const fileBlocks: string[] = [];
  for (const ref of feature.ownedFiles) {
    fileBlocks.push(await fileBlock(root, ref.path));
  }
  return `You are fleet applying one small repair in the current repository.

Fix only the finding below. Keep the patch minimal. Add or update focused tests when feasible.
Do not commit, push, switch branches, or run destructive git commands.
Do not defer: never output TODO comments, "fix in a follow-up", or "address later". Either
apply a minimal in-scope fix now or return the JSON with a concrete skip reason. Deferral is
not a valid outcome.
After editing, return strict JSON only:
{
  "summary": "string",
  "findingIds": ["string"],
  "plannedFiles": ["string"],
  "risk": "low|medium|high",
  "steps": ["string"],
  "validationCommands": ["string"]
}

Finding:
${JSON.stringify(finding, null, 2)}

Feature:
${JSON.stringify(feature, null, 2)}

Owned files:
${fileBlocks.join("\n\n")}`;
}

async function fileBlock(root: string, path: string): Promise<string> {
  const full = resolve(root, path);
  if (!isInside(root, full)) {
    return `--- ${path}\n[skipped: path escapes repository root]`;
  }
  const realRoot = await realpath(root).catch(() => root);
  const realFull = await realpath(full).catch(() => full);
  if (!isInside(realRoot, realFull)) {
    return `--- ${path}\n[skipped: path escapes repository root]`;
  }
  const contents = await readFile(full, "utf8").catch(() => "[unreadable]");
  const trimmed =
    contents.length > 24_000 ? `${contents.slice(0, 24_000)}\n...[truncated]` : contents;
  return `--- ${path}\n${trimmed}`;
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
