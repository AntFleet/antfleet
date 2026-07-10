// Patch Agent — verifier-first patch gate.
//
// Sits between the patch-generation orchestrator (which fans out one
// `proposePatch` call per (finding × provider) and emits a flat
// `ProviderPatchProposal[]`) and the comment renderer (PR4). For each
// distinct findingId, decides whether a patch ships.
//
// KEY RULE (v2 — inversion): cross-model agreement is a CONFIDENCE LABEL,
// not a ship gate. A single structurally-valid patch SHIPS; the downstream
// deterministic patch-verifier (applies the patch in an ephemeral worktree,
// runs tests + PoC) is the real gate. Previously a valid Opus patch was
// discarded whenever the other model failed for an unrelated reason
// (usually `outside_diff_hunk`) or declined — nulling recoverable fixes
// into `models_disagreed`. We now let the one-sided-valid patch flow
// through so the verifier decides.
//
//   - Both providers returned a non-null patch → ship the anthropic (Opus)
//     patch, `confidence: "unanimous"`.
//   - Exactly one side returned a patch → ship that patch (prefer Opus),
//     `confidence: "single_model"`. Diff content need not match; the
//     verifier vets it downstream.
//   - Neither side produced a shippable patch → no patch ships. This is
//     the ONLY `models_disagreed` case now: "neither side produced a
//     shippable patch", not "sides differed".
//
// When no patch ships we record the most informative reason available:
//   - All providers skipped for the same structural reason → that reason
//     (e.g. all said `outside_diff_hunk` — the finding isn't fixable here)
//   - `patch_apply_failed` = the diff's old-side did not match the real file
//     (hallucinated/stale context; the patch would fail `git apply`)
//   - Both declined / errored with no shippable patch → `models_disagreed`
//   - All providers errored → `generation_error`

// Re-declared structurally so this module doesn't take a dep on the web
// app's lib/. The orchestrator emits this shape and we consume it.
export type PatchSkipReason =
  | "models_disagreed"
  | "outside_diff_hunk"
  | "generation_error"
  | "disabled"
  | "size_cap"
  | "patch_apply_failed";

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
  // anthropic (Opus) proposal when present; otherwise the lone non-anthropic
  // patch. modelId reflects the resolved model id the provider actually used.
  patch: string | null;
  modelId: string | null;
  // Confidence label attached to a shipped patch (v2 inversion). Not a ship
  // gate — the downstream verifier is. `"unanimous"` = both providers
  // proposed a non-null patch; `"single_model"` = exactly one side did (the
  // shipped patch is unverified consensus, vetted only by the verifier).
  // `null` when no patch ships. The renderer surfaces `single_model` honestly
  // so we never present a lone patch as if two models agreed.
  confidence: "unanimous" | "single_model" | null;
  // Gate-level verdict. Null when a patch shipped. When no patch shipped, the
  // aggregate reason: models_disagreed when sides disagreed, or the shared
  // structural reason (outside_diff_hunk / generation_error / size_cap / disabled)
  // when all providers declined for the same reason. Distinct from `skipReasons`
  // (per-provider mechanism) — this is the gate's output, those are provider inputs.
  gateOutcome: PatchSkipReason | null;
  // Eval Phase 0 — dual-candidate persistence. These fields are additive.
  candidates: { opus: string | null; gpt5: string | null };
  // Provider-side explanation returned by proposePatch. This is operator
  // observability only: rendered comments still show only shipped patches.
  rationales?: { opus: string | null; gpt5: string | null };
  // Per-provider raw orchestrator skip reason captured from each side's
  // ProviderPatchProposal. A side that proposed a patch has null here; a
  // side that didn't carries the orchestrator reason
  // (generation_error / outside_diff_hunk / size_cap) or null if it
  // returned patch=null with a clean rationale (the "policy decline" case).
  skipReasons: { opus: PatchSkipReason | null; gpt5: PatchSkipReason | null };
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
 * them. A findingId with only one provider's non-null patch ships that patch
 * with `confidence: "single_model"` (the verifier vets it downstream). A
 * findingId where NO provider produced a shippable patch yields
 * `models_disagreed` / `patch: null` / `confidence: null`.
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
  // Use the registered providerName from each proposal rather than hard-coded
  // strings so virtual/openrouter providers that are not named "openai" are
  // correctly captured in the eval candidates slots.
  const anthropicProposal = group.find((p) => p.providerName === WINNING_PROVIDER);
  const otherProposal = group.find((p) => p.providerName !== WINNING_PROVIDER);
  const candidates = {
    opus: anthropicProposal?.patch ?? null,
    gpt5: otherProposal?.patch ?? null,
  };
  const rationales = {
    opus: anthropicProposal?.rationale ?? null,
    gpt5: otherProposal?.rationale ?? null,
  };
  const skipReasons = {
    opus: anthropicProposal?.skipReason ?? null,
    gpt5: otherProposal?.skipReason ?? null,
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
      gateOutcome: null,
      confidence: "unanimous",
      candidates,
      rationales,
      skipReasons,
      selector: "deterministic-opus",
    };
  }

  // One-sided proposal (v2 inversion): exactly one side produced a
  // structurally-valid patch. SHIP it — the downstream verifier is the real
  // gate. Prefer the anthropic (Opus) patch; if only the non-anthropic side
  // has one, ship that. Confidence is `single_model` so the renderer can be
  // honest that this patch did not clear cross-model consensus. The selector
  // (`no-gpt5-deterministic-skip` / `no-opus-deterministic-skip`) already
  // encodes which side was present.
  if (withPatch.length > 0) {
    const shipped = anthropic ?? otherWithPatch;
    // `anthropic || otherWithPatch` is non-null here because withPatch is
    // non-empty and every element is one or the other provider role.
    const selector: PatchSelector =
      candidates.opus !== null ? "no-gpt5-deterministic-skip" : "no-opus-deterministic-skip";
    return {
      findingId,
      patch: shipped?.patch ?? null,
      modelId: shipped?.modelId ?? shipped?.providerName ?? null,
      gateOutcome: null,
      confidence: "single_model",
      candidates,
      rationales,
      skipReasons,
      selector,
    };
  }

  // No provider proposed a patch — nothing shippable. Surface the shared
  // reason when one exists; otherwise pick the most informative single
  // reason. Priority:
  //   generation_error > size_cap > outside_diff_hunk > disabled > null-decline
  // This (and pickReason's null-decline fallthrough) is now the ONLY path
  // that yields `models_disagreed`: it means "neither side produced a
  // shippable patch", not "sides differed".
  const reason = pickReason(group);
  return {
    findingId,
    patch: null,
    modelId: null,
    gateOutcome: reason,
    confidence: null,
    candidates,
    rationales,
    skipReasons,
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
  // emits it from `proposePatch` calls — the real reasons below are what we
  // see here. `patch_apply_failed` ranks just under `generation_error`: a
  // patch whose old-side didn't match the real file (hallucinated/stale
  // context) is a strong, informative reason and outranks size_cap /
  // outside_diff_hunk. Kept `disabled` in the chain for completeness.
  if (reasons.has("generation_error")) return "generation_error";
  if (reasons.has("patch_apply_failed")) return "patch_apply_failed";
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
