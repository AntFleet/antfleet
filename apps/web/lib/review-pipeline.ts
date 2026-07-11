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
import { isSingleModelTierEnabled } from "./single-model-tier-env";
import { isTransientError } from "./review-worker-config";
import { messageOf } from "./log";

// A single-model shadow-tier entry (Win 2). Carries the flagging provider
// alongside the finding — a bare Finding[] would lose the attribution the
// next build (3rd-model adjudication) needs to route the independent judge
// (`providers[0]`). Derived from `disagreements` where exactly one provider
// flagged a HIGH/CRITICAL finding.
export type SingleModelFinding = { finding: Finding; provider: string };

// Per-provider outcome of one review. `error` is non-null when the API call
// failed; `output` is non-null when it returned a parseable response. Both
// non-null is impossible; both null is impossible.
//
// `transient` classifies a FAILED provider's error as retryable infra noise
// (timeout, 429, 5xx, reasoning-starvation) vs. a persistent fault. Always
// false on the success path (there was no error to classify). The worker
// reads this to decide whether a degraded review — one that lost consensus
// because a provider failed — deserves another attempt to reach true 2/2,
// rather than terminating at 0 findings and discarding the survivor's work.
export type PerProviderResult = {
  name: string;
  modelId: string;
  output: ReviewOutput | null;
  error: string | null;
  transient: boolean;
  ms: number;
};

export type ReviewBundle = {
  perProvider: PerProviderResult[];
  modelIds: Record<string, string>;
  agreed: Finding[];
  disagreements: Disagreement[];
  // Single-model shadow tier (Win 2). The HIGH/CRITICAL findings only one
  // provider flagged — the unanimous gate drops these into `disagreements`,
  // and this is a filtered projection of that same array (no new clustering).
  // Each entry carries the flagging provider (forward-compat for the
  // 3rd-model adjudication build). Empty unless ANTFLEET_SINGLE_MODEL_TIER is
  // on, and always empty when the review degraded (no real agreement basis).
  singleModelTier: SingleModelFinding[];
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
  // Cyber tier (Daybreak follow-up). When 'cyber' the prompt's defender-
  // context preamble is prepended, authorizing minimal PoC + repro detail
  // in findings. Defaults to 'default' so existing call sites are
  // byte-identical to pre-cyber-tier behavior.
  tier?: "default" | "cyber";
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
        singleModelTier: [],
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
    ...(args.tier !== undefined ? { tier: args.tier } : {}),
  });

  const tasks = STACK.map(async ({ name, modelId, provider }): Promise<PerProviderResult> => {
    const start = Date.now();
    try {
      const output = await provider.review(".", prompt, null, { signal: args.signal ?? null });
      return { name, modelId, output, error: null, transient: false, ms: Date.now() - start };
    } catch (err) {
      // Classify the raw error BEFORE stringifying — isTransientError reads
      // `err.message` off the Error instance; messageOf collapses it to a
      // plain string for the audit trail.
      const transient = isTransientError(err);
      const message = messageOf(err);
      return { name, modelId, output: null, error: message, transient, ms: Date.now() - start };
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

  // Single-model shadow tier — gated behind the env flag so the whole
  // computation is inert by default. Degraded reviews yield [] (agreement
  // wasn't real, so "one provider flagged this" carries no signal).
  const singleModelTier =
    isSingleModelTierEnabled() && !degraded ? selectSingleModelTier(merged.disagreements) : [];

  return {
    perProvider,
    modelIds,
    agreed: merged.agreed,
    disagreements: merged.disagreements,
    singleModelTier,
    totalMs,
    estimatedCostUsd: estimateRunCost(STACK.map((p) => p.name)) + triageCost,
    agreementMode: mode,
    degraded,
    degradedReason,
    triage,
  };
}

// Single-model shadow tier projection (Win 2). A disagreement with exactly
// one flagging provider is a "single-model finding"; we keep only HIGH /
// CRITICAL severities (the recoverable-value band). Carries the flagging
// provider (disagreement.providers[0]) so the downstream 3rd-model judge can
// route to an independent model. Order follows the disagreements array so the
// shadow finding_index space is deterministic across retries.
export function selectSingleModelTier(disagreements: Disagreement[]): SingleModelFinding[] {
  const out: SingleModelFinding[] = [];
  for (const d of disagreements) {
    if (d.providers.length !== 1) continue;
    const severity = d.finding.severity;
    if (severity !== "high" && severity !== "critical") continue;
    const provider = d.providers[0];
    if (provider === undefined) continue;
    out.push({ finding: d.finding, provider });
  }
  return out;
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
