// Patch Agent v1.5 — patch agreement gate.
//
// Sits between the patch-generation orchestrator (which fans out one
// `proposePatch` call per (finding × provider) and emits a flat
// `ProviderPatchProposal[]`) and the comment renderer (PR4). For each
// distinct findingId, decides whether a patch ships — by the rule:
//
//   "Agreement" = both providers returned a non-null patch proposal for
//   the SAME findingId. Diff content need not match byte-for-byte; we
//   ship the anthropic (Opus) patch deterministically.
//
// This is the lightest defensible interpretation of "unanimous patch":
// the agreement signal is "both willing to fix here" rather than "both
// proposed the same fix". A future eval harness can move us toward
// content-overlap voting; until then, byte-overlap would be too strict
// (semantic-equivalent diffs differ in whitespace, identifier choice).
//
// On disagreement, we record the most informative reason available:
//   - All providers skipped for the same structural reason → that reason
//     (e.g. all said `outside_diff_hunk` — the finding isn't fixable here)
//   - One provider proposed, the other did not → `models_disagreed`
//   - All providers errored → `generation_error`

// Re-declared structurally so this module doesn't take a dep on the web
// app's lib/. The orchestrator emits this shape and we consume it.
export type PatchSkipReason =
  | "models_disagreed"
  | "outside_diff_hunk"
  | "generation_error"
  | "disabled"
  | "size_cap";

// Token spend for one provider call. Structurally re-declared (same shape
// as types.ts TokenUsage) so patch-gate keeps zero deps on the web app /
// types module. Null when the provider made no billable call (precheck
// skip) or the SDK omitted usage. The patch-agent layer sums these into
// reviews.cost_patch_usd and persists the per-finding split.
export type ProviderPatchUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ProviderPatchProposal = {
  providerName: string;
  findingId: string;
  patch: string | null;
  // Resolved model id the provider used for this call. Threaded through
  // from PatchSuggestionResult.modelId so the gate's PatchDecision
  // records the truthful model rather than a captured-at-module-load
  // constant. Null when the provider declined or errored.
  modelId: string | null;
  skipReason: PatchSkipReason | null;
  rationale: string | null;
  // Token spend for this (finding × provider) call. Null when no billable
  // call was made (precheck skip) or the response omitted usage.
  usage: ProviderPatchUsage | null;
};

export type PatchSelector =
  | "deterministic-opus"
  | "no-opus-deterministic-skip"
  | "no-gpt5-deterministic-skip"
  | "no-candidates";

export type PatchDecision = {
  findingId: string;
  // Non-null when the gate selected a winning patch. The winner is the
  // anthropic (Opus) proposal by spec; modelId reflects the resolved
  // model id the provider actually used.
  patch: string | null;
  modelId: string | null;
  // Non-null exactly when patch is null.
  skipReason: PatchSkipReason | null;
  // Eval Phase 0 — dual-candidate persistence. These fields are additive;
  // existing callers that only read patch/modelId/skipReason are unaffected.
  candidates: { opus: string | null; gpt5: string | null };
  // Provider-side explanation returned by proposePatch. This is operator
  // observability only: rendered comments still show only shipped patches.
  rationales: { opus: string | null; gpt5: string | null };
  selector: PatchSelector;
};

// Deterministic winner. PR3 hard-codes anthropic; revisit when the eval
// harness lands and we can move to a quality-based selection.
const WINNING_PROVIDER = "anthropic";

/**
 * Decide the patch outcome for every findingId represented in `proposals`.
 * Pure function — caller persists the resulting PatchDecision[] into
 * finding_status via the queries layer.
 *
 * Inputs are NOT required to be aligned by findingId; this function groups
 * them. A findingId with only one provider's proposal yields
 * `models_disagreed` (the other provider must have been missing from the
 * orchestrator's input — that itself is a degenerate case the gate refuses
 * to ship through).
 */
export function decidePatchOutcomes(proposals: readonly ProviderPatchProposal[]): PatchDecision[] {
  const byFinding = groupByFinding(proposals);
  const decisions: PatchDecision[] = [];
  for (const [findingId, group] of byFinding) {
    decisions.push(decideOne(findingId, group));
  }
  // Stable order so tests + receipts read predictably.
  return decisions.toSorted((a, b) => a.findingId.localeCompare(b.findingId));
}

function decideOne(findingId: string, group: readonly ProviderPatchProposal[]): PatchDecision {
  const withPatch = group.filter((p) => p.patch !== null);

  // Extract per-provider candidates for eval persistence.
  const anthropicProposal = group.find((p) => p.providerName === WINNING_PROVIDER);
  const openaiProposal = group.find((p) => p.providerName === "openai");
  const candidates = {
    opus: anthropicProposal?.patch ?? null,
    gpt5: openaiProposal?.patch ?? null,
  };
  const rationales = {
    opus: anthropicProposal?.rationale ?? null,
    gpt5: openaiProposal?.rationale ?? null,
  };

  // Happy path: every provider in the group proposed a patch. Ship the
  // anthropic one. Tolerant of additional providers (future stack growth)
  // — if anthropic and openai both proposed, we ship even if a third
  // provider declined; the agreement bar is "two non-null", not "all".
  const anthropic = withPatch.find((p) => p.providerName === WINNING_PROVIDER);
  const otherWithPatch = withPatch.find((p) => p.providerName !== WINNING_PROVIDER);
  if (anthropic !== undefined && otherWithPatch !== undefined) {
    return {
      findingId,
      patch: anthropic.patch,
      // Use the modelId the anthropic provider actually used for this
      // call (e.g. "claude-opus-4-7"). Falls back to the providerName
      // when the provider somehow returned a null modelId — that's a
      // bug in the provider, not the gate, but we still emit a non-
      // null value so the receipt comment doesn't say "(model: null)".
      modelId: anthropic.modelId ?? WINNING_PROVIDER,
      skipReason: null,
      candidates,
      rationales,
      selector: "deterministic-opus",
    };
  }

  // Disagreement: one-sided proposal. Per spec, fall back to findings-only
  // with `models_disagreed`. The orchestrator may have separately surfaced
  // a structural reason on the declining side — prefer that when it's
  // more informative than the generic "disagreed".
  if (withPatch.length > 0) {
    const selector: PatchSelector =
      candidates.opus !== null ? "no-gpt5-deterministic-skip" : "no-opus-deterministic-skip";
    return {
      findingId,
      patch: null,
      modelId: null,
      skipReason: "models_disagreed",
      candidates,
      rationales,
      selector,
    };
  }

  // No provider proposed a patch. Surface the shared reason when one
  // exists; otherwise pick the most informative single reason. Priority:
  //   generation_error > size_cap > outside_diff_hunk > disabled > null-decline
  const reason = pickReason(group);
  return {
    findingId,
    patch: null,
    modelId: null,
    skipReason: reason,
    candidates,
    rationales,
    selector: "no-candidates",
  };
}

function pickReason(group: readonly ProviderPatchProposal[]): PatchSkipReason | null {
  const reasons = new Set<PatchSkipReason>();
  for (const p of group) {
    if (p.skipReason !== null) reasons.add(p.skipReason);
  }
  if (reasons.size === 0) {
    // All providers cleanly declined (patch=null AND skipReason=null).
    // Per spec, a unilateral decline-by-both is still "models_disagreed":
    // the gate refuses to escalate a no-patch outcome to a positive
    // signal. A future audit pass on these would tell us whether the
    // models are systematically declining the same way.
    return "models_disagreed";
  }
  if (reasons.size === 1) {
    // Both providers gave the same reason — that IS the informative outcome.
    const [only] = [...reasons];
    return only ?? "models_disagreed";
  }
  // Priority: most-informative-first. `disabled` is in the union for the
  // worker-layer fallthrough (env flag off) but the orchestrator never
  // emits it from `proposePatch` calls — the four real reasons below
  // are what we see here. Kept in the priority chain for completeness.
  if (reasons.has("generation_error")) return "generation_error";
  if (reasons.has("size_cap")) return "size_cap";
  if (reasons.has("outside_diff_hunk")) return "outside_diff_hunk";
  if (reasons.has("disabled")) return "disabled";
  return "models_disagreed";
}

function groupByFinding(
  proposals: readonly ProviderPatchProposal[],
): Map<string, ProviderPatchProposal[]> {
  const out = new Map<string, ProviderPatchProposal[]>();
  for (const p of proposals) {
    const existing = out.get(p.findingId);
    if (existing === undefined) {
      out.set(p.findingId, [p]);
    } else {
      existing.push(p);
    }
  }
  return out;
}
