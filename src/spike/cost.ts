/**
 * Spike cost estimation + hard ceiling.
 *
 * These numbers are rough estimates, not exact pricing. The intent is to
 * prevent runaway spend on a multi-run spike, not to bill the user. Rates
 * approximate provider list prices in early 2026, mixing input + output
 * tokens at a typical review prompt size (~6k input chars + ~2k output
 * chars). They will drift -- update when pricing changes materially.
 */

export const DEFAULT_COST_CEILING_USD = 5;

/** Estimated USD per logical review() call, by provider name. */
export const COST_PER_CALL_USD_ESTIMATES: Readonly<Record<string, number>> = {
  // claude-opus-4-7 ~ $15/MTok input, $75/MTok output. 6k input + 2k output ~ $0.24.
  anthropic: 0.25,
  // gpt-5.5 list pricing is uncertain; use a conservative $10/MTok in, $30/MTok out.
  openai: 0.15,
  // deepseek/deepseek-chat via OpenRouter ~ $0.27/MTok in, $1.10/MTok out -> tiny.
  openrouter: 0.01,
  // glm-5.2 (Zhipu/z.ai) on the Coding-Plan Anthropic-compat endpoint -> cheap.
  zhipu: 0.02,
  // codex CLI is billed via the operator's subscription, not pay-per-call.
  codex: 0,
};

const DEFAULT_PER_CALL_UNKNOWN = 0.1;

export function estimateCallCost(provider: string): number {
  return COST_PER_CALL_USD_ESTIMATES[provider] ?? DEFAULT_PER_CALL_UNKNOWN;
}

/** Estimated cost of one stacked run (one review() call per provider). */
export function estimateRunCost(providers: readonly string[]): number {
  let sum = 0;
  for (const p of providers) {
    sum += estimateCallCost(p);
  }
  return sum;
}

export type CeilingDecision = {
  abort: boolean;
  projectedCost: number;
  reason: string;
};

/**
 * Decide whether to start the next run given the cumulative spend so far.
 * Aborts if starting would push us strictly over the ceiling. Equality is OK
 * to keep the policy operator-friendly at round budgets ($5 exactly).
 */
export function shouldAbortBeforeRun(
  cumulativeCostUsd: number,
  nextRunEstimateUsd: number,
  ceilingUsd: number,
): CeilingDecision {
  const projected = cumulativeCostUsd + nextRunEstimateUsd;
  if (projected > ceilingUsd) {
    return {
      abort: true,
      projectedCost: projected,
      reason: `next run would push estimated cost to $${projected.toFixed(2)} (ceiling $${ceilingUsd.toFixed(2)})`,
    };
  }
  return {
    abort: false,
    projectedCost: projected,
    reason: `under ceiling: $${projected.toFixed(2)} / $${ceilingUsd.toFixed(2)}`,
  };
}
