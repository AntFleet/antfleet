import { anthropicProvider } from "antfeed-fleet/providers/anthropic";
import { openaiProvider } from "antfeed-fleet/providers/openai";
import { mergeFindings } from "antfeed-fleet/providers/agreement";
import { buildSpikePrompt } from "antfeed-fleet/spike/build-prompt";
import { estimateRunCost } from "antfeed-fleet/spike/cost";
import type {
  AgreementMode,
  Disagreement,
  Finding,
  ProviderReview,
  ReviewOutput,
} from "./review-types";
import type { ChangedFile } from "./github-files";

// Per-provider outcome of one review. `error` is non-null when the API call
// failed; `output` is non-null when it returned a parseable response. Both
// non-null is impossible; both null is impossible.
export type PerProviderResult = {
  name: string;
  modelId: string;
  output: ReviewOutput | null;
  error: string | null;
  ms: number;
};

export type ReviewBundle = {
  perProvider: PerProviderResult[];
  modelIds: Record<string, string>;
  agreed: Finding[];
  disagreements: Disagreement[];
  totalMs: number;
  estimatedCostUsd: number;
  agreementMode: AgreementMode;
  // When fewer than the required number of providers succeed, the review is
  // 'degraded' — agreement isn't real (a 1-of-1 'unanimous' is just one
  // provider, not consensus). The pitch (b) language requires honest framing:
  // we surface findings only when ≥2 frontier reviewers both flagged them.
  // Degraded reviews still capture per-provider output for the audit trail
  // but agreed is held at [].
  degraded: boolean;
  degradedReason: string | null;
};

// The v1 stack — locked in §6 of AGENTS.md. Same providers + model ids the
// V2/V3 verdicts ran against. Keep modelId in sync with each provider's
// DEFAULT_MODEL constant when those bump.
const STACK = [
  { name: "anthropic", provider: anthropicProvider, modelId: "claude-opus-4-7" },
  { name: "openai", provider: openaiProvider, modelId: "gpt-5" },
] as const;

export async function reviewPR(args: {
  files: ChangedFile[];
  owner: string;
  repo: string;
  prNumber: number;
  mode?: AgreementMode;
}): Promise<ReviewBundle> {
  const mode: AgreementMode = args.mode ?? "unanimous";
  const prompt = buildSpikePrompt({
    projectName: `github:${args.owner}/${args.repo}`,
    projectRoot: ".",
    featureId: `pr-${args.prNumber}`,
    featureTitle: `${args.owner}/${args.repo} PR #${args.prNumber} (changed files)`,
    files: args.files.map((f) => ({ path: f.filename, contents: f.contents })),
  });

  const t0 = Date.now();
  const tasks = STACK.map(async ({ name, modelId, provider }): Promise<PerProviderResult> => {
    const start = Date.now();
    try {
      const output = await provider.review(".", prompt, null);
      return { name, modelId, output, error: null, ms: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, modelId, output: null, error: message, ms: Date.now() - start };
    }
  });
  const perProvider = await Promise.all(tasks);
  const totalMs = Date.now() - t0;

  const successful: ProviderReview[] = perProvider
    .filter((r): r is PerProviderResult & { output: ReviewOutput } => r.output !== null)
    .map((r) => ({ providerName: r.name, output: r.output }));

  const requiredVoters = requiredVotersFor(mode, STACK.length);
  const degraded = successful.length < requiredVoters;
  const merged = degraded
    ? { agreed: [], disagreements: [] as Disagreement[] }
    : mergeFindings(successful, mode);
  const degradedReason = degraded
    ? `${successful.length}/${STACK.length} providers succeeded; ${mode} requires ${requiredVoters}`
    : null;

  const modelIds = Object.fromEntries(STACK.map((p) => [p.name, p.modelId]));

  return {
    perProvider,
    modelIds,
    agreed: merged.agreed,
    disagreements: merged.disagreements,
    totalMs,
    estimatedCostUsd: estimateRunCost(STACK.map((p) => p.name)),
    agreementMode: mode,
    degraded,
    degradedReason,
  };
}

// Voters required for a given agreement mode to be honest. mergeFindings'
// internal threshold is computed against the count of successful inputs,
// which means a 1-of-1 'unanimous' silently degrades to "what the surviving
// provider said". We refuse to call that agreement.
function requiredVotersFor(mode: AgreementMode, stackSize: number): number {
  if (mode === "any") return 1;
  if (mode === "majority") return Math.floor(stackSize / 2) + 1;
  return stackSize; // unanimous
}
