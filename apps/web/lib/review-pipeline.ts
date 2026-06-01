import { anthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "@antfleet/cli/providers/anthropic";
import { openaiProvider, OPENAI_DEFAULT_MODEL } from "@antfleet/cli/providers/openai";
import { mergeFindings } from "@antfleet/cli/providers/agreement";
import { buildSpikePrompt } from "@antfleet/cli/spike/build-prompt";
import { estimateRunCost } from "@antfleet/cli/spike/cost";
import type {
  AgreementMode,
  Disagreement,
  Finding,
  ProviderReview,
  ReviewOutput,
} from "./review-types";
import type { ChangedFile } from "./github-files";
import { triagePR, TRIAGE_COST_USD, type TriageResult } from "./triage-provider";
import { messageOf } from "./log";

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
  // Triage Agent pre-pass result. Non-null only in 'unanimous' mode (the
  // production path), where a cheap Haiku call decides whether the PR is
  // worth the frontier stack. Null when triage was bypassed (any/majority
  // test/manual modes). When triage decides to skip, the frontier providers
  // never run and `agreed`/`perProvider` are empty.
  triage: TriageResult | null;
};

// The v1 stack — locked in §6 of AGENTS.md. Same providers + model ids the
// V2/V3 verdicts ran against. modelId tracks the provider module's exported
// default constant so a single bump there propagates to the audit trail.
const STACK = [
  { name: "anthropic", provider: anthropicProvider, modelId: ANTHROPIC_DEFAULT_MODEL },
  { name: "openai", provider: openaiProvider, modelId: OPENAI_DEFAULT_MODEL },
] as const;

export async function reviewPR(args: {
  files: ChangedFile[];
  owner: string;
  repo: string;
  prNumber: number;
  mode?: AgreementMode;
  signal?: AbortSignal;
}): Promise<ReviewBundle> {
  const mode: AgreementMode = args.mode ?? "unanimous";
  const t0 = Date.now();

  // Triage: cheap Haiku pre-check before the expensive frontier stack.
  // Only runs in unanimous mode (the production path). Fails open on error
  // (triagePR returns worthEscalating: true with a non-null `error`), so a
  // triage failure can never drop a review.
  let triage: TriageResult | null = null;
  if (mode === "unanimous") {
    triage = await triagePR({ files: args.files, signal: args.signal ?? null });
    // Deterministic safety floor on the triage SUCCESS path. triagePR's input
    // is fully attacker-controlled (a PR author owns every changed file's
    // path + contents), so a confidently-wrong or prompt-injected
    // `worthEscalating: false` would silently drop a real review without ever
    // hitting the fail-open catch. We therefore only honour a triage skip when
    // EVERY changed file is pure documentation; anything else — source code,
    // CI workflows (.yml), manifests/configs (.json/.toml), data — escalates
    // regardless of what triage said. Driving this off a docs-only allowlist
    // (rather than a code-only denylist) is fail-safe: a workflow- or
    // manifest-only PR, both real attack vectors, cannot be skipped on
    // attacker-influenced output, and any future reviewable extension defaults
    // to "review", never "skip".
    if (!triage.worthEscalating && !triageMaySkip(args.files)) {
      triage = {
        ...triage,
        worthEscalating: true,
        reason: `${triage.reason} (overridden: non-docs files present, escalating)`,
      };
    }
    if (!triage.worthEscalating) {
      return {
        perProvider: [],
        modelIds: {},
        agreed: [],
        disagreements: [],
        totalMs: Date.now() - t0,
        estimatedCostUsd: 0,
        agreementMode: mode,
        degraded: false,
        degradedReason: null,
        triage,
      };
    }
  }

  const prompt = buildSpikePrompt({
    projectName: `github:${args.owner}/${args.repo}`,
    projectRoot: ".",
    featureId: `pr-${args.prNumber}`,
    featureTitle: `${args.owner}/${args.repo} PR #${args.prNumber} (changed files)`,
    files: args.files.map((f) => ({ path: f.filename, contents: f.contents })),
  });

  const tasks = STACK.map(async ({ name, modelId, provider }): Promise<PerProviderResult> => {
    const start = Date.now();
    try {
      const output = await provider.review(".", prompt, null, { signal: args.signal ?? null });
      return { name, modelId, output, error: null, ms: Date.now() - start };
    } catch (err) {
      const message = messageOf(err);
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

  // Only charge the triage call when it actually ran (unanimous + escalated).
  // In any/majority modes triage is null and no Haiku call was made.
  const triageCost = triage !== null ? TRIAGE_COST_USD : 0;

  return {
    perProvider,
    modelIds,
    agreed: merged.agreed,
    disagreements: merged.disagreements,
    totalMs,
    estimatedCostUsd: estimateRunCost(STACK.map((p) => p.name)) + triageCost,
    agreementMode: mode,
    degraded,
    degradedReason,
    triage,
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

// The ONLY extensions triage is allowed to skip. Pure documentation only —
// everything else in the reviewable set (source code, .yml workflows,
// .json/.toml manifests, data) must reach the frontier stack even when triage
// votes to skip. This is the deterministic backstop behind the triage skip
// decision: it keys off the filename extension (which comes from the GitHub PR
// file list), not the LLM's answer or the attacker-controlled file contents.
// Allowlist-by-skippable is fail-safe — any extension not listed here forces a
// review, so the dangerous direction (silently skipping a risky file) is
// impossible without an explicit entry.
const TRIAGE_SKIPPABLE_EXTENSIONS = new Set([".md", ".mdx"]);

// True only when EVERY changed file is pure documentation, i.e. triage's skip
// vote may be honoured. An empty extension or any non-docs file makes this
// false → escalate.
function triageMaySkip(files: ChangedFile[]): boolean {
  return files.every((f) => {
    const dot = f.filename.lastIndexOf(".");
    if (dot < 0) return false;
    return TRIAGE_SKIPPABLE_EXTENSIONS.has(f.filename.slice(dot).toLowerCase());
  });
}
