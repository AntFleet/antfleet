// Patch Agent — token-based cost accounting for the patch-proposal lane.
//
// PATCH_AGENT_ENABLED went live in prod 2026-05-30. Every unanimous finding
// now triggers up to two patch-proposal calls (Opus + GPT-5) whose spend was
// previously written to reviews.cost_patch_usd as a hardcoded 0. This module
// turns the real per-call token counts (captured from the provider SDK usage
// blocks and threaded through ProviderPatchProposal.usage) into a USD figure.
//
// Observability-only: this never gates drawdown. The review is still billed at
// the fixed REVIEW_PRICE; cost_patch_usd exists so re-pricing analysis can see
// what the patch lane actually costs against that fixed price.

import type { ProviderPatchProposal } from "./patch-generation";

export type TokenUsage = { inputTokens: number; outputTokens: number };

type Rate = { input: number; output: number };

// Published list prices in USD per 1,000,000 tokens.
//
// VERIFY-BY DATE: 2026-06-18. Sources:
//   - claude-opus-4-7: Anthropic API pricing — $15/MTok input, $75/MTok output.
//   - gpt-5.5: OpenAI API pricing (developers.openai.com/api/docs/pricing,
//     fetched 2026-06-18) — $5/MTok input, $30/MTok output.
//   - gpt-5: Historical row for reconciliation of rows generated before the
//     2026-06-18 default bump (RECONCILE_GPT5_MODEL backfill). Same $5/$30
//     rate the model carried at the time of the cohort being reconciled.
// These are list rates (no cache discount, no batch discount applied) so the
// estimate is a conservative upper bound on real spend. Update both the rates
// AND this date when provider pricing changes materially.
export const PATCH_TOKEN_PRICING_USD_PER_MTOK: Readonly<Record<string, Rate>> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5": { input: 5, output: 30 },
};

// Fallback by provider name when the resolved model id isn't in the table
// above (e.g. a future model id we haven't priced yet). Keeps the estimate
// non-zero rather than silently dropping spend on a model-id bump.
const PROVIDER_FALLBACK_RATE: Readonly<Record<string, Rate>> = {
  anthropic: { input: 15, output: 75 },
  openai: { input: 5, output: 30 },
};

const TOKENS_PER_MILLION = 1_000_000;

// Upper bound of the numeric(10,4) column cost_patch_usd lands in. A value
// above this — or non-finite, or negative — would make the `.toFixed(4)` DB
// write throw (Postgres rejects "NaN" / out-of-range for numeric). Realistic
// patch spend is cents, so this only fires if a provider SDK returns a
// malformed usage block; clamping degrades to a safe persisted value rather
// than failing the (observability-only) write.
const MAX_NUMERIC_10_4 = 999_999.9999;

/**
 * Coerce a computed cost into something safely persistable to numeric(10,4):
 * non-finite or negative → 0; over-range → the column max; otherwise rounded
 * to 4 dp. Pure. Applied at every cost producer so no write path can throw on
 * a malformed input.
 */
export function toPersistableCostUsd(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n * 10_000) / 10_000, MAX_NUMERIC_10_4);
}

/**
 * USD cost of a single provider call. Pure. Returns 0 when usage is null
 * (no billable call was made, or the SDK omitted usage) or when neither the
 * model id nor the provider name resolves to a known rate. Resolution order:
 * exact model-id match → provider-name fallback → 0.
 */
export function callCostUsd(
  providerName: string,
  modelId: string | null,
  usage: TokenUsage | null,
): number {
  if (usage === null) return 0;
  const rate =
    (modelId !== null ? PATCH_TOKEN_PRICING_USD_PER_MTOK[modelId] : undefined) ??
    PROVIDER_FALLBACK_RATE[providerName];
  if (rate === undefined) return 0;
  const input = (usage.inputTokens / TOKENS_PER_MILLION) * rate.input;
  const output = (usage.outputTokens / TOKENS_PER_MILLION) * rate.output;
  return input + output;
}

/**
 * Aggregate USD cost of the whole patch lane for one review: sum the cost of
 * every (finding × provider) proposal call. Pure — no I/O, no mocking needed.
 * Rounded to 4 decimal places to match the numeric(10,4) column it lands in.
 */
export function estimatePatchCostUsd(proposals: readonly ProviderPatchProposal[]): number {
  let sum = 0;
  for (const p of proposals) {
    sum += callCostUsd(p.providerName, p.modelId, p.usage);
  }
  return toPersistableCostUsd(sum);
}

export type PerFindingTokenSplit = {
  opus: TokenUsage | null;
  gpt5: TokenUsage | null;
};

/**
 * Group proposal usage per finding, split by provider, for the per-finding
 * token columns on finding_status. `opus` is the anthropic proposal's usage,
 * `gpt5` the openai proposal's usage. A provider that never produced a
 * proposal for a finding (or made no billable call) stays null. Pure.
 */
export function patchTokensByFinding(
  proposals: readonly ProviderPatchProposal[],
): Map<string, PerFindingTokenSplit> {
  const byFinding = new Map<string, PerFindingTokenSplit>();
  for (const p of proposals) {
    const split = byFinding.get(p.findingId) ?? { opus: null, gpt5: null };
    if (p.providerName === "anthropic" && p.usage !== null) split.opus = p.usage;
    if (p.providerName === "openai" && p.usage !== null) split.gpt5 = p.usage;
    byFinding.set(p.findingId, split);
  }
  return byFinding;
}
