// GLM 5.2 shadow-replay dogfood harness (decision memo 2026-07-21).
//
// Replays stored Opus/GPT-5 disagreement events through the PRODUCTION
// adjudication path (third-model-adjudication.runAdjudication — same prompt,
// scrub, nonce fencing, fail-open) several times per event to measure:
//   - rerun stability (verdict flip-rate — an unstable judge is a coin)
//   - corroborated-tier precision against held-out human labels
// in two variants:
//   - 'full'    : prod-identical prompt (finding prose + code excerpt)
//   - 'blinded' : finding prose withheld — the judge sees location, category,
//                 severity, and the code excerpt only. Controls for
//                 judge-prompt contamination (GLM being talked into a verdict
//                 by the flagging model's own prose).
//
// Zero new review spend: candidates come from reviews.agreement_decision /
// reviews.provider_responses JSONB already in the DB. Only GLM judge calls
// are made, and only by the CLI with --apply. The production flags and
// finding_status are never touched.

import { createHash } from "node:crypto";
import {
  runAdjudication,
  type AdjudicationOutcome,
  type RunAdjudicationArgs,
} from "./third-model-adjudication";
import { evidenceOverlaps } from "./disagreements";
import type { Finding } from "./review-types";

export const HARNESS_VERSION = "glm-shadow-replay-v1";

export const SHADOW_VARIANTS = ["full", "blinded"] as const;
export type ShadowVariant = (typeof SHADOW_VARIANTS)[number];

const HIGH_SEVERITIES = new Set(["high", "critical"]);

export type ShadowCandidate = {
  reviewId: string;
  findingKey: string;
  flaggingProvider: string;
  finding: Finding;
  // Where the candidate came from: the persisted Win2 shadow tier, or mined
  // out of provider_responses for reviews that predate the tier.
  origin: "single_model_tier" | "mined";
};

// Minimal projection of a reviews row needed for sampling. JSONB columns are
// `unknown` — every access below is defensive.
export type ReviewRowForSampling = {
  reviewId: string;
  agreementDecision: unknown;
  providerResponses: unknown;
};

export function candidateKey(reviewId: string, provider: string, finding: Finding): string {
  const ev = finding.evidence[0];
  // Line range participates in the key so two same-titled findings from one
  // provider at different locations in the same file stay distinct events.
  const location = ev === undefined ? "" : `${ev.path}:${ev.startLine ?? ""}-${ev.endLine ?? ""}`;
  return createHash("sha256")
    .update(`${reviewId}|${provider}|${finding.title}|${location}`)
    .digest("hex")
    .slice(0, 32);
}

function isGlmProvider(provider: string): boolean {
  const p = provider.toLowerCase();
  return p.includes("zhipu") || p.includes("glm");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function looksLikeFinding(value: unknown): value is Finding {
  const rec = asRecord(value);
  return (
    rec !== null &&
    typeof rec["title"] === "string" &&
    typeof rec["severity"] === "string" &&
    Array.isArray(rec["evidence"])
  );
}

// Primary source: agreement_decision.singleModelTier[] — the persisted Win2
// shadow tier, entries shaped {provider, finding, adjudication?}. These carry
// the full Finding (including evidence[].quote) exactly as production
// adjudication would consume it.
function sampleFromSingleModelTier(row: ReviewRowForSampling): ShadowCandidate[] {
  const decision = asRecord(row.agreementDecision);
  const tier = decision?.["singleModelTier"];
  if (!Array.isArray(tier)) return [];
  const out: ShadowCandidate[] = [];
  for (const entry of tier) {
    const rec = asRecord(entry);
    if (rec === null) continue;
    const provider = rec["provider"];
    const finding = rec["finding"];
    if (typeof provider !== "string" || !looksLikeFinding(finding)) continue;
    if (isGlmProvider(provider)) continue;
    out.push({
      reviewId: row.reviewId,
      findingKey: candidateKey(row.reviewId, provider, finding),
      flaggingProvider: provider,
      finding,
      origin: "single_model_tier",
    });
  }
  return out;
}

// Fallback source for reviews that predate the Win2 tier: mine
// provider_responses.perProvider[].output.findings[] for SOLO findings — a
// finding with no evidence-overlapping counterpart in the OTHER provider's
// list (same ±line pairing the /disagreements page uses).
function sampleFromProviderResponses(row: ReviewRowForSampling): ShadowCandidate[] {
  const responses = asRecord(row.providerResponses);
  const perProvider = responses?.["perProvider"];
  if (!Array.isArray(perProvider)) return [];

  const byProvider: Array<{ provider: string; findings: Finding[] }> = [];
  for (const entry of perProvider) {
    const rec = asRecord(entry);
    if (rec === null || typeof rec["name"] !== "string") continue;
    const output = asRecord(rec["output"]);
    const findings = output?.["findings"];
    if (!Array.isArray(findings)) continue;
    byProvider.push({
      provider: rec["name"],
      findings: findings.filter(looksLikeFinding),
    });
  }
  if (byProvider.length < 2) return [];

  const out: ShadowCandidate[] = [];
  for (const { provider, findings } of byProvider) {
    if (isGlmProvider(provider)) continue;
    // Solo means "no counterpart among the FRONTIER reviewers". An auxiliary
    // provider (e.g. a GLM shadow run) overlapping the finding must not
    // disqualify it — mirror the anthropic/openai pairing the /disagreements
    // page uses.
    const others = byProvider.filter((p) => p.provider !== provider && !isGlmProvider(p.provider));
    for (const finding of findings) {
      if (finding.evidence.length === 0) continue;
      const hasCounterpart = others.some((other) =>
        other.findings.some((candidate) => evidenceOverlaps(finding.evidence, candidate.evidence)),
      );
      if (hasCounterpart) continue;
      out.push({
        reviewId: row.reviewId,
        findingKey: candidateKey(row.reviewId, provider, finding),
        flaggingProvider: provider,
        finding,
        origin: "mined",
      });
    }
  }
  return out;
}

export type SampleOptions = {
  // Default: HIGH/CRITICAL only — production-parity with the shadow tier's
  // gate. Corpus-bias caveat: solo findings over-represent model-specific
  // misses relative to the production distribution; the report states this.
  allSeverities?: boolean;
  limit?: number;
};

export function sampleShadowCandidates(
  rows: ReviewRowForSampling[],
  opts: SampleOptions = {},
): ShadowCandidate[] {
  const seen = new Set<string>();
  const out: ShadowCandidate[] = [];
  for (const row of rows) {
    const tierCandidates = sampleFromSingleModelTier(row);
    // Mined candidates only fill in when the review has no persisted tier —
    // the tier is authoritative for those reviews.
    const candidates =
      tierCandidates.length > 0 ? tierCandidates : sampleFromProviderResponses(row);
    for (const candidate of candidates) {
      if (seen.has(candidate.findingKey)) continue;
      if (
        opts.allSeverities !== true &&
        !HIGH_SEVERITIES.has(candidate.finding.severity.toLowerCase())
      ) {
        continue;
      }
      seen.add(candidate.findingKey);
      out.push(candidate);
      if (opts.limit !== undefined && out.length >= opts.limit) return out;
    }
  }
  return out;
}

// Blinded variant: withhold EVERYTHING the flagging model authored — prose
// (title/reasoning/recommendation) AND its claimed classification
// (category/severity), which also leak the claimed defect shape. The judge
// works from the file location and code window alone ("source-window-only",
// decision memo). Structure (and therefore the production prompt scaffold,
// fencing, and JSON contract) is unchanged — only the DATA content differs.
// The classification placeholders are cast through the Finding enums; the
// prompt only ever interpolates them as strings, and the per-run snapshot
// records exactly what the judge saw.
export const BLINDED_PLACEHOLDER = "(withheld — judge from the code excerpt alone)";
export const BLINDED_CLASSIFICATION = "(withheld)";

export function redactFindingForBlindedJudge(finding: Finding): Finding {
  return {
    ...finding,
    title: BLINDED_PLACEHOLDER,
    reasoning: BLINDED_PLACEHOLDER,
    recommendation: BLINDED_PLACEHOLDER,
    category: BLINDED_CLASSIFICATION as Finding["category"],
    severity: BLINDED_CLASSIFICATION as Finding["severity"],
  };
}

export type ShadowRunRow = {
  reviewId: string;
  findingKey: string;
  flaggingProvider: string;
  variant: ShadowVariant;
  runIndex: number;
  verdict: string;
  corroborated: boolean;
  reason: string;
  judgeModel: string;
  harnessVersion: string;
  findingSnapshot: Finding;
  excerptPresent: boolean;
  ms: number;
  error: string | null;
};

export type ShadowReplayIo = {
  // True when the (findingKey, variant, runIndex) cell already exists —
  // idempotent resume skips it.
  hasRun: (findingKey: string, variant: ShadowVariant, runIndex: number) => Promise<boolean>;
  insertRun: (row: ShadowRunRow) => Promise<void>;
  // Test seam / production default: third-model-adjudication.runAdjudication.
  runOne?: (args: RunAdjudicationArgs) => Promise<AdjudicationOutcome>;
  log?: (message: string) => void;
};

export type ShadowReplayArgs = {
  candidates: ShadowCandidate[];
  runsPerVariant: number;
  variants: readonly ShadowVariant[];
  io: ShadowReplayIo;
};

export type ShadowReplaySummary = {
  attempted: number;
  inserted: number;
  skippedExisting: number;
  errored: number;
};

export async function runShadowReplay(args: ShadowReplayArgs): Promise<ShadowReplaySummary> {
  const runOne = args.io.runOne ?? runAdjudication;
  const log = args.io.log ?? (() => undefined);
  const summary: ShadowReplaySummary = {
    attempted: 0,
    inserted: 0,
    skippedExisting: 0,
    errored: 0,
  };

  // Sequential on purpose: a dogfood batch is latency-insensitive, and one
  // in-flight GLM call at a time keeps the flat-subscription endpoint polite.
  for (const candidate of args.candidates) {
    for (const variant of args.variants) {
      const finding =
        variant === "blinded" ? redactFindingForBlindedJudge(candidate.finding) : candidate.finding;
      for (let runIndex = 0; runIndex < args.runsPerVariant; runIndex++) {
        summary.attempted++;
        if (await args.io.hasRun(candidate.findingKey, variant, runIndex)) {
          summary.skippedExisting++;
          continue;
        }
        const outcome = await runOne({
          finding,
          flaggingProvider: candidate.flaggingProvider,
        });
        if (outcome.error !== null) summary.errored++;
        await args.io.insertRun({
          reviewId: candidate.reviewId,
          findingKey: candidate.findingKey,
          flaggingProvider: candidate.flaggingProvider,
          variant,
          runIndex,
          verdict: outcome.verdict,
          corroborated: outcome.corroborated,
          reason: outcome.reason,
          judgeModel: outcome.thirdModel,
          harnessVersion: HARNESS_VERSION,
          findingSnapshot: finding,
          excerptPresent: (finding.evidence[0]?.quote ?? "").length > 0,
          ms: outcome.ms,
          error: outcome.error,
        });
        summary.inserted++;
        log(
          `${candidate.findingKey.slice(0, 8)} ${variant} run ${runIndex}: ${outcome.verdict}` +
            (outcome.error !== null ? ` (error: ${outcome.error})` : ""),
        );
      }
    }
  }
  return summary;
}

// ─── report ─────────────────────────────────────────────────────────────────

export type StoredRun = {
  findingKey: string;
  variant: string;
  runIndex: number;
  verdict: string;
  corroborated: boolean;
  error: string | null;
};

export type StoredLabel = {
  findingKey: string;
  // 'real' | 'not_real'
  label: string;
};

export type VariantReport = {
  variant: string;
  events: number;
  runs: number;
  erroredRuns: number;
  // Events whose runs did not all return the same verdict.
  unstableEvents: number;
  flipRate: number;
  // Events whose majority verdict is 'confirm'.
  corroboratedEvents: number;
  // Confusion matrix over the LABELED subset, majority verdict vs label.
  labeled: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  // TP / (TP + FP); null when nothing was corroborated in the labeled subset.
  precision: number | null;
};

export const CORPUS_BIAS_NOTE =
  "Corpus bias: candidates are solo (single-model) findings, which over-represent " +
  "model-specific misses relative to the production review distribution. Precision " +
  "and stability generalize; absolute recall numbers do not.";

export function computeShadowReport(runs: StoredRun[], labels: StoredLabel[]): VariantReport[] {
  const labelByKey = new Map(labels.map((l) => [l.findingKey, l.label]));
  const variants = [...new Set(runs.map((r) => r.variant))].toSorted();
  const reports: VariantReport[] = [];

  for (const variant of variants) {
    const variantRuns = runs.filter((r) => r.variant === variant);
    const byEvent = new Map<string, StoredRun[]>();
    for (const run of variantRuns) {
      const list = byEvent.get(run.findingKey) ?? [];
      list.push(run);
      byEvent.set(run.findingKey, list);
    }

    let unstable = 0;
    let corroboratedEvents = 0;
    let labeled = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    for (const [findingKey, eventRuns] of byEvent) {
      // Errored runs are fail-open 'uncertain' by construction; they count
      // toward instability honestly rather than being filtered out.
      const verdicts = eventRuns.map((r) => r.verdict);
      if (new Set(verdicts).size > 1) unstable++;

      const confirms = eventRuns.filter((r) => r.verdict === "confirm").length;
      const majorityCorroborated = confirms * 2 > eventRuns.length;
      if (majorityCorroborated) corroboratedEvents++;

      const label = labelByKey.get(findingKey);
      if (label === undefined) continue;
      labeled++;
      const isReal = label === "real";
      if (majorityCorroborated && isReal) tp++;
      else if (majorityCorroborated && !isReal) fp++;
      else if (!majorityCorroborated && isReal) fn++;
      else tn++;
    }

    reports.push({
      variant,
      events: byEvent.size,
      runs: variantRuns.length,
      erroredRuns: variantRuns.filter((r) => r.error !== null).length,
      unstableEvents: unstable,
      flipRate: byEvent.size === 0 ? 0 : unstable / byEvent.size,
      corroboratedEvents,
      labeled,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      trueNegatives: tn,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
    });
  }
  return reports;
}

export function renderShadowReportMarkdown(
  reports: VariantReport[],
  generatedAtIso: string,
): string {
  const lines = [
    "# GLM 5.2 shadow-replay dogfood report",
    "",
    `Generated: ${generatedAtIso} · harness: ${HARNESS_VERSION}`,
    "",
    "Promotion gate (decision memo 2026-07-21): corroborated precision >= unanimous-tier",
    "precision (~0.80 ground-truth survival) AND rerun-stable verdicts (flip-rate low,",
    ">=4/5 agreement). The production flag stays OFF until both hold on the FULL variant,",
    "with the BLINDED variant as the contamination control.",
    "",
    "| variant | events | runs | errored | unstable events | flip rate | corroborated | labeled | TP | FP | FN | TN | precision |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of reports) {
    lines.push(
      `| ${r.variant} | ${r.events} | ${r.runs} | ${r.erroredRuns} | ${r.unstableEvents} | ` +
        `${r.flipRate.toFixed(2)} | ${r.corroboratedEvents} | ${r.labeled} | ${r.truePositives} | ` +
        `${r.falsePositives} | ${r.falseNegatives} | ${r.trueNegatives} | ` +
        `${r.precision === null ? "n/a" : r.precision.toFixed(2)} |`,
    );
  }
  lines.push("", CORPUS_BIAS_NOTE, "");
  return lines.join("\n");
}
