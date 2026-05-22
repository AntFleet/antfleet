// Patch Agent v1.5 — top-level orchestrator wired into review-worker.
//
// Sequencing (between agreement gate and comment post):
//   1. Check the env flag. Disabled → return null (worker skips patches).
//   2. Look up the patch-proposing providers. (The worker already used
//      providers via review-pipeline.ts; we re-derive here so the
//      generation lane doesn't bypass the same source-of-truth.)
//   3. Derive findingIds deterministically from (reviewId, index) — must
//      match the writes recordFindingStatuses will do downstream.
//   4. Fan out generateReviewPatches() (PR2). 60s timeout per call.
//   5. Run decidePatchOutcomes() (PR3). One PatchDecision per finding.
//   6. Return { decisions, byIndex, elapsedMs }.
//
// The worker takes byIndex into formatPRComment and persists decisions
// via recordPatchDecisions.

import { anthropicProvider } from "@antfleet/cli/providers/anthropic";
import { openaiProvider } from "@antfleet/cli/providers/openai";
import {
  decidePatchOutcomes,
  type PatchDecision,
} from "@antfleet/cli/providers/patch-gate";
import { makeFindingId } from "@/db/queries";
import {
  generateReviewPatches,
  type PatchProposingProvider,
} from "./patch-generation";
import { isPatchAgentEnabledForInstall } from "./patch-agent-env";
import type { PatchForRender } from "./pr-comment";
import type { ChangedFile } from "./github-files";
import type { Finding } from "./review-types";

// Default provider stack for the patch lane. Mirrors review-pipeline.ts
// STACK but uses only providers that implement proposePatch (PR2 added
// the method to anthropic + openai; mock / mock-fail / codex opt out).
const DEFAULT_PATCH_PROVIDERS: PatchProposingProvider[] = [
  ...(typeof anthropicProvider.proposePatch === "function"
    ? [
        {
          name: anthropicProvider.name,
          proposePatch: anthropicProvider.proposePatch.bind(anthropicProvider),
        },
      ]
    : []),
  ...(typeof openaiProvider.proposePatch === "function"
    ? [
        {
          name: openaiProvider.name,
          proposePatch: openaiProvider.proposePatch.bind(openaiProvider),
        },
      ]
    : []),
];

export type PatchAgentOutcome = {
  decisions: PatchDecision[];
  byIndex: Map<number, PatchForRender>;
  elapsedMs: number;
};

export type RunPatchAgentArgs = {
  reviewId: string;
  installationId: number;
  findings: readonly Finding[];
  changedFiles: readonly ChangedFile[];
  // Test seam — overrides DEFAULT_PATCH_PROVIDERS.
  providers?: readonly PatchProposingProvider[];
  // Test seam — overrides isPatchAgentEnabledForInstall().
  enabled?: () => Promise<boolean> | boolean;
};

/**
 * Returns null when disabled (worker skips the patch lane entirely).
 * Returns an outcome otherwise. Throws are caught here: spec §2 mandates
 * generation failure cannot block comment posting, so the worker treats
 * a thrown error as "no patches this run".
 *
 * Enablement resolution: per-install override (installations.patchAgentEnabled)
 * takes precedence over the env flag. PR6 added the override path.
 */
export async function runPatchAgent(
  args: RunPatchAgentArgs,
): Promise<PatchAgentOutcome | null> {
  const enabled = args.enabled
    ? await args.enabled()
    : await isPatchAgentEnabledForInstall(args.installationId);
  if (!enabled) return null;
  if (args.findings.length === 0) {
    return { decisions: [], byIndex: new Map(), elapsedMs: 0 };
  }

  const providers = args.providers ?? DEFAULT_PATCH_PROVIDERS;
  if (providers.length < 2) {
    // The agreement gate requires anthropic + at least one other provider.
    // Configuration without two providers is "models_disagreed" by default;
    // we short-circuit here to save the API calls.
    return { decisions: [], byIndex: new Map(), elapsedMs: 0 };
  }

  const findingIds = args.findings.map((_f, index) => makeFindingId(args.reviewId, index));

  const generation = await generateReviewPatches({
    reviewId: args.reviewId,
    findings: args.findings,
    findingIds,
    changedFiles: args.changedFiles,
    providers,
  });
  const decisions = decidePatchOutcomes(generation.proposals);

  const byIndex = new Map<number, PatchForRender>();
  for (const [i, fid] of findingIds.entries()) {
    const d = decisions.find((x) => x.findingId === fid);
    if (d === undefined) continue;
    if (d.patch !== null && d.modelId !== null) {
      byIndex.set(i, { patch: d.patch, modelId: d.modelId });
    }
  }

  return { decisions, byIndex, elapsedMs: generation.elapsedMs };
}
