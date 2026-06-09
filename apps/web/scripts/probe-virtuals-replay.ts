/**
 * Replay historical Patch Agent prompts through Virtuals.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/probe-virtuals-replay.ts
 *
 * Safety: read-only DB queries; no Anthropic/OpenAI direct API calls.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import { sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { VirtualsClient, type VirtualsModel, type VirtualsUsage } from "../lib/virtuals-client";
import { getPublicChangedFiles } from "../lib/github-files-public";
import { parseHunkRanges, rangeOverlapsHunk } from "../lib/diff-hunks";
import { buildPatchPrompt } from "../lib/patch-generation";
import type { ChangedFile } from "../lib/github-files";
import type { Finding } from "../lib/review-types";

loadDotenv({ path: ".env.local", quiet: true });

const execFileAsync = promisify(execFile);
const MAX_CALLS = 100;
const RUNS_PER_PROMPT = 2;
const VIRTUALS_WEEKLY_CREDIT_USD = 200;
const VERDICT_PATH = "../../../.omc/research/virtuals-replay-verdict.md";

type RouteId = "opus-virtuals" | "gpt5-virtuals";

type ReplayRoute = {
  id: RouteId;
  storedColumn: "opus" | "gpt5";
  preferredModels: readonly string[];
  resolvedModel: string;
  modelParityGap: string | null;
};

type CohortRow = {
  findingId: string;
  findingIndex: number;
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  agreementDecision: unknown;
  suggestedPatchOpus: string | null;
  suggestedPatchGpt5: string | null;
};

type CohortCounts = {
  total: number;
  bothProposed: number;
  opusOnly: number;
  gpt5Only: number;
  neither: number;
};

type DbLike = {
  execute: <TRow extends Record<string, unknown> = Record<string, unknown>>(
    query: string | SQLWrapper,
  ) => Promise<{ rows?: TRow[] }>;
};

type PatchParseResult = {
  patch: string | null;
  jsonOk: boolean;
  refusal: boolean;
  error: string | null;
};

export type ApplyCheckResult = {
  ok: boolean;
  skipped: boolean;
  reason: string | null;
};

type ReplayRunMeasurement = {
  routeId: RouteId;
  findingId: string;
  run: number;
  model: string;
  storedHash: string | null;
  diffHashMatch: boolean;
  jsonOk: boolean;
  parsedOk: boolean;
  apply: ApplyCheckResult;
  refusal: boolean;
  firstTokenMs: number | null;
  completeMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  anomaly: string | null;
};

type DirectBaseline = {
  findingId: string;
  routeId: RouteId;
  parsedOk: boolean;
  apply: ApplyCheckResult;
};

type RepoCheckout = {
  dir: string | null;
  skippedReason: string | null;
};

type RouteSummary = {
  route: ReplayRoute;
  n: number;
  parsedOkRate: number;
  gitApplyOkRate: number;
  refusalRate: number;
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
  avgCostUsd: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  diffHashMatchRate: number;
  directParsedOkRate: number;
  directGitApplyOkRate: number;
  anomalies: string[];
};

const findingSchema: z.ZodType<Finding> = z.object({
  title: z.string(),
  category: z.enum([
    "bug",
    "security",
    "performance",
    "concurrency",
    "api-contract",
    "data-loss",
    "test-gap",
    "docs-gap",
    "build-release",
    "maintainability",
  ]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  label: z.enum(["blocking", "nit", "optional", "fyi"]).default("blocking"),
  confidence: z.enum(["high", "medium", "low"]),
  evidence: z.array(
    z.object({
      path: z.string(),
      startLine: z.number().int().positive().nullable(),
      endLine: z.number().int().positive().nullable(),
      symbol: z.string().nullable().optional().default(null),
      quote: z.string().nullable().optional().default(null),
    }),
  ),
  reasoning: z.string(),
  reproduction: z.string().nullable(),
  recommendation: z.string(),
  whyTestsDoNotAlreadyCoverThis: z.string(),
  suggestedRegressionTest: z.string().nullable(),
  minimumFixScope: z.string(),
  requiresPolicyReview: z.boolean().optional().default(false),
  upstreamOrigin: z.object({ package: z.string(), reason: z.string() }).nullable().optional().default(null),
});

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: pnpm exec tsx scripts/probe-virtuals-replay.ts");
    console.log("Requires VIRTUALS_API_KEY and DATABASE_URL in apps/web/.env.local or the shell.");
    return;
  }
  if (!process.env["VIRTUALS_API_KEY"]) throw new Error("VIRTUALS_API_KEY is required");
  if (!process.env["DATABASE_URL"]) throw new Error("DATABASE_URL is required");

  const { db } = await import("../db/index");
  const client = new VirtualsClient();
  const [counts, rows, models] = await Promise.all([
    readCohortCounts(db),
    readReplayCohort(db),
    client.listModels(),
  ]);
  const routes = resolveRoutes(models);
  const rates = buildRateTable(models, routes);
  const callsPlanned = rows.filter((r) => r.suggestedPatchOpus !== null).length * RUNS_PER_PROMPT +
    rows.filter((r) => r.suggestedPatchGpt5 !== null).length * RUNS_PER_PROMPT;

  if (callsPlanned > MAX_CALLS) {
    throw new Error(`planned Virtuals calls ${callsPlanned} exceeds hard cap ${MAX_CALLS}`);
  }

  console.log(
    `[cohort] total=${counts.total} both=${counts.bothProposed} opus_only=${counts.opusOnly} gpt5_only=${counts.gpt5Only} neither=${counts.neither}`,
  );
  console.log(`[calls] planned=${callsPlanned} cap=${MAX_CALLS}`);

  const changedFilesCache = new Map<string, Promise<ChangedFile[]>>();
  const checkoutCache = new Map<string, Promise<RepoCheckout>>();
  const directBaselines: DirectBaseline[] = [];
  const measurements: ReplayRunMeasurement[] = [];

  let callsMade = 0;
  for (const route of routes) {
    const routeRows = rows.filter((row) => storedPatch(row, route) !== null);
    console.log(`[route:${route.id}] model=${route.resolvedModel} n=${routeRows.length}`);
    for (const row of routeRows) {
      const stored = storedPatch(row, route);
      if (stored === null) continue;
      const finding = extractFinding(row.agreementDecision, row.findingIndex);
      const changedFiles = await cachedChangedFiles(changedFilesCache, row);
      const prompt = buildPatchPrompt(finding, promptMode(finding, changedFiles));
      const checkout = await cachedCheckout(checkoutCache, row);
      directBaselines.push({
        findingId: row.findingId,
        routeId: route.id,
        parsedOk: parsesAsUnifiedDiff(stored),
        apply: await checkGitApply({ checkout, row, patch: stored, finding }),
      });

      for (let run = 1; run <= RUNS_PER_PROMPT; run++) {
        callsMade += 1;
        if (callsMade > MAX_CALLS) throw new Error(`Virtuals hard cap exceeded at call ${callsMade}`);
        const response = await client.streamChatCompletion({
          model: route.resolvedModel,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        });
        const measurement = await measureReplayRun({
          routeId: route.id,
          findingId: row.findingId,
          run,
          model: response.model,
          responseContent: response.content,
          responseRefusal: response.refusal,
          responseUsage: response.usage ?? null,
          firstTokenMs: response.firstTokenMs,
          completeMs: response.completeMs,
          storedPatch: stored,
          rate: rates.get(route.id) ?? null,
          applyCheck: async (patch) => checkGitApply({ checkout, row, patch, finding }),
        });
        measurements.push(measurement);
        console.log(
          `[${route.id}] ${row.findingId} run=${run} parsed=${measurement.parsedOk} apply=${measurement.apply.ok} latency=${measurement.completeMs}ms`,
        );
      }
    }
  }

  const summaries = routes.map((route) =>
    summarizeRoute(route, measurements, directBaselines, rates.get(route.id) ?? null),
  );
  const verdict = renderVerdict({
    counts,
    callsPlanned,
    callsMade,
    routes,
    summaries,
    generatedAt: new Date().toISOString(),
  });
  await writeFile(new URL(VERDICT_PATH, import.meta.url), verdict);
}

async function readCohortCounts(db: DbLike) {
  const result = await db.execute(sql`
    select
      count(*)::int as total,
      count(*) filter (where suggested_patch_opus is not null and suggested_patch_gpt5 is not null)::int as "bothProposed",
      count(*) filter (where suggested_patch_opus is not null and suggested_patch_gpt5 is null)::int as "opusOnly",
      count(*) filter (where suggested_patch_opus is null and suggested_patch_gpt5 is not null)::int as "gpt5Only",
      count(*) filter (where suggested_patch_opus is null and suggested_patch_gpt5 is null)::int as neither
    from finding_status
    where input_tokens_opus is not null
       or output_tokens_opus is not null
       or input_tokens_gpt5 is not null
       or output_tokens_gpt5 is not null
  `);
  return rowAt<CohortCounts>(result);
}

async function readReplayCohort(db: DbLike) {
  const result = await db.execute(sql`
    select
      fs.finding_id as "findingId",
      fs.finding_index as "findingIndex",
      r.review_id as "reviewId",
      r.owner,
      r.repo,
      r.pr_number as "prNumber",
      r.commit_sha as "commitSha",
      r.agreement_decision as "agreementDecision",
      fs.suggested_patch_opus as "suggestedPatchOpus",
      fs.suggested_patch_gpt5 as "suggestedPatchGpt5"
    from finding_status fs
    join reviews r on r.review_id = fs.review_id
    where (fs.input_tokens_opus is not null
       or fs.output_tokens_opus is not null
       or fs.input_tokens_gpt5 is not null
       or fs.output_tokens_gpt5 is not null)
      and (fs.suggested_patch_opus is not null or fs.suggested_patch_gpt5 is not null)
      and r.is_benchmark = true
      and r.owner is not null
      and r.repo is not null
    order by r.created_at asc, fs.finding_index asc
  `);
  const rows = result.rows ?? [];
  return rows.map((raw) => raw as CohortRow);
}

function resolveRoutes(models: readonly VirtualsModel[]): ReplayRoute[] {
  const ids = new Set(models.map((model) => model.id));
  const opusModel = ids.has("claude-opus-4-7") ? "claude-opus-4-7" : "claude-opus-4-8";
  return [
    {
      id: "opus-virtuals",
      storedColumn: "opus",
      preferredModels: ["claude-opus-4-7", "claude-opus-4-8"],
      resolvedModel: opusModel,
      modelParityGap:
        opusModel === "claude-opus-4-7"
          ? null
          : "claude-opus-4-7 was not exposed by Virtuals; replay used claude-opus-4-8.",
    },
    {
      id: "gpt5-virtuals",
      storedColumn: "gpt5",
      preferredModels: ["openai-gpt-55"],
      resolvedModel: "openai-gpt-55",
      modelParityGap: ids.has("openai-gpt-55") ? null : "openai-gpt-55 was not listed by /v1/models.",
    },
  ];
}

type TokenRate = { promptUsdPerToken: number; completionUsdPerToken: number };

function buildRateTable(models: readonly VirtualsModel[], routes: readonly ReplayRoute[]): Map<RouteId, TokenRate> {
  const out = new Map<RouteId, TokenRate>();
  for (const route of routes) {
    const model = models.find((candidate) => candidate.id === route.resolvedModel);
    const rate = model === undefined ? null : extractTokenRate(model);
    if (rate !== null) out.set(route.id, rate);
  }
  return out;
}

function extractTokenRate(model: VirtualsModel): TokenRate | null {
  const pricing = model.pricing;
  if (pricing === undefined) return null;
  const prompt = numberField(pricing, ["prompt", "input", "prompt_tokens", "input_tokens"]);
  const completion = numberField(pricing, ["completion", "output", "completion_tokens", "output_tokens"]);
  if (prompt === null || completion === null) return null;
  return { promptUsdPerToken: prompt, completionUsdPerToken: completion };
}

function numberField(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "number") return raw;
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function extractFinding(agreementDecision: unknown, findingIndex: number): Finding {
  if (typeof agreementDecision !== "object" || agreementDecision === null) {
    throw new Error("agreement_decision is not an object");
  }
  const agreed = (agreementDecision as Record<string, unknown>)["agreed"];
  if (!Array.isArray(agreed)) throw new Error("agreement_decision.agreed is missing");
  return findingSchema.parse(agreed[findingIndex]);
}

function promptMode(finding: Finding, changedFiles: readonly ChangedFile[]): "inline" | "artifact" {
  const evidence = finding.evidence[0];
  if (evidence === undefined) return "inline";
  const normalized = normalizePath(evidence.path);
  const changed = changedFiles.find((file) => normalizePath(file.filename) === normalized);
  if (changed === undefined) return "inline";
  return rangeOverlapsHunk(parseHunkRanges(changed.patch), evidence.startLine, evidence.endLine)
    ? "inline"
    : "artifact";
}

async function cachedChangedFiles(cache: Map<string, Promise<ChangedFile[]>>, row: CohortRow) {
  const key = `${row.owner}/${row.repo}#${row.prNumber}@${row.commitSha}`;
  let promise = cache.get(key);
  if (promise === undefined) {
    promise = getPublicChangedFiles({
      owner: row.owner,
      repo: row.repo,
      prNumber: row.prNumber,
      headSha: row.commitSha,
    });
    cache.set(key, promise);
  }
  return promise;
}

async function cachedCheckout(cache: Map<string, Promise<RepoCheckout>>, row: CohortRow) {
  const key = `${row.owner}/${row.repo}@${row.commitSha}`;
  let promise = cache.get(key);
  if (promise === undefined) {
    promise = checkoutRepoAtSha(row);
    cache.set(key, promise);
  }
  return promise;
}

async function checkoutRepoAtSha(row: Pick<CohortRow, "owner" | "repo" | "commitSha">): Promise<RepoCheckout> {
  const dir = await mkdtemp(join(tmpdir(), "virtuals-replay-"));
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["remote", "add", "origin", `https://github.com/${row.owner}/${row.repo}.git`], {
      cwd: dir,
    });
    await execFileAsync("git", ["fetch", "--depth", "1", "origin", row.commitSha], { cwd: dir });
    await execFileAsync("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: dir });
    return { dir, skippedReason: null };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    return { dir: null, skippedReason: messageOf(err) };
  }
}

async function checkGitApply(args: {
  checkout: RepoCheckout;
  row: Pick<CohortRow, "findingId">;
  patch: string;
  finding: Finding;
}): Promise<ApplyCheckResult> {
  if (args.checkout.dir === null) {
    return { ok: false, skipped: true, reason: `sha_unavailable: ${args.checkout.skippedReason}` };
  }
  const targetPath = args.finding.evidence[0]?.path ?? null;
  const applyPatch = normalizeDiffForApply(args.patch, targetPath);
  const patchPath = join(args.checkout.dir, `.virtuals-${args.row.findingId}.patch`);
  await writeFile(patchPath, applyPatch);
  try {
    await execFileAsync("git", ["apply", "--check", patchPath], { cwd: args.checkout.dir });
    return { ok: true, skipped: false, reason: null };
  } catch (err) {
    return { ok: false, skipped: false, reason: messageOf(err) };
  }
}

export async function measureReplayRun(args: {
  routeId: RouteId;
  findingId: string;
  run: number;
  model: string;
  responseContent: string;
  responseRefusal: string | null;
  responseUsage: VirtualsUsage | null;
  firstTokenMs: number | null;
  completeMs: number;
  storedPatch: string;
  rate: TokenRate | null;
  applyCheck: (patch: string) => Promise<ApplyCheckResult>;
}): Promise<ReplayRunMeasurement> {
  const parsed = parsePatchPayload(args.responseContent, args.responseRefusal);
  const patch = parsed.patch;
  const parsedOk = patch !== null && parsesAsUnifiedDiff(patch);
  const apply =
    patch === null
      ? { ok: false, skipped: true, reason: parsed.error ?? "no patch" }
      : await args.applyCheck(patch);
  const promptTokens = integerOrNull(args.responseUsage?.prompt_tokens);
  const completionTokens = integerOrNull(args.responseUsage?.completion_tokens);
  return {
    routeId: args.routeId,
    findingId: args.findingId,
    run: args.run,
    model: args.model,
    storedHash: hashNormalizedDiff(args.storedPatch),
    diffHashMatch: patch === null ? false : hashNormalizedDiff(patch) === hashNormalizedDiff(args.storedPatch),
    jsonOk: parsed.jsonOk,
    parsedOk,
    apply,
    refusal: parsed.refusal,
    firstTokenMs: args.firstTokenMs,
    completeMs: args.completeMs,
    promptTokens,
    completionTokens,
    costUsd:
      args.rate === null || promptTokens === null || completionTokens === null
        ? null
        : promptTokens * args.rate.promptUsdPerToken + completionTokens * args.rate.completionUsdPerToken,
    anomaly: parsed.error,
  };
}

export function parsePatchPayload(content: string, refusal: string | null = null): PatchParseResult {
  if (refusal !== null && refusal.length > 0) {
    return { patch: null, jsonOk: false, refusal: true, error: "refusal" };
  }
  const trimmed = stripCodeFence(content.trim());
  if (trimmed.length === 0) {
    return { patch: null, jsonOk: false, refusal: false, error: "empty response" };
  }
  try {
    const json = JSON.parse(trimmed) as unknown;
    if (typeof json !== "object" || json === null) {
      return { patch: null, jsonOk: false, refusal: false, error: "JSON response was not an object" };
    }
    const patch = (json as Record<string, unknown>)["patch"];
    if (patch === null) return { patch: null, jsonOk: true, refusal: false, error: "patch=null" };
    if (typeof patch === "string") return { patch, jsonOk: true, refusal: false, error: null };
    return { patch: null, jsonOk: false, refusal: false, error: "JSON patch field was not string|null" };
  } catch {
    if (parsesAsUnifiedDiff(trimmed)) return { patch: trimmed, jsonOk: false, refusal: false, error: "raw diff response" };
    return { patch: null, jsonOk: false, refusal: false, error: "invalid JSON and not a diff" };
  }
}

export function parsesAsUnifiedDiff(patch: string): boolean {
  const normalized = normalizeDiffText(patch);
  if (normalized.length === 0) return false;
  if (parseHunkRanges(normalized).length === 0) return false;
  const hasHeader = /^---\s+/mu.test(normalized) && /^\+\+\+\s+/mu.test(normalized);
  return hasHeader || normalized.startsWith("@@ ");
}

export function normalizeDiffForApply(patch: string, targetPath: string | null): string {
  const normalized = normalizeDiffText(patch);
  if (/^---\s+/mu.test(normalized) && /^\+\+\+\s+/mu.test(normalized)) return normalized;
  if (targetPath !== null && normalized.startsWith("@@ ")) {
    const cleanPath = normalizePath(targetPath);
    return `--- a/${cleanPath}\n+++ b/${cleanPath}\n${normalized}`;
  }
  return normalized;
}

export function hashNormalizedDiff(patch: string): string {
  return createHash("sha256").update(normalizeDiffText(patch)).digest("hex");
}

function summarizeRoute(
  route: ReplayRoute,
  measurements: readonly ReplayRunMeasurement[],
  directBaselines: readonly DirectBaseline[],
  rate: TokenRate | null,
): RouteSummary {
  const rows = measurements.filter((m) => m.routeId === route.id);
  const direct = directBaselines.filter((b) => b.routeId === route.id);
  const anomalies = rows
    .filter((row) => row.anomaly !== null || row.apply.skipped || row.apply.reason !== null)
    .map((row) => `${row.findingId} run ${row.run}: ${row.anomaly ?? row.apply.reason}`);
  if (route.modelParityGap !== null) anomalies.unshift(route.modelParityGap);
  if (rate === null) anomalies.unshift(`No token pricing found in /v1/models for ${route.resolvedModel}.`);
  return {
    route,
    n: rows.length,
    parsedOkRate: rateOf(rows, (row) => row.parsedOk),
    gitApplyOkRate: rateOf(rows, (row) => row.apply.ok),
    refusalRate: rateOf(rows, (row) => row.refusal),
    avgPromptTokens: avg(rows.map((row) => row.promptTokens)),
    avgCompletionTokens: avg(rows.map((row) => row.completionTokens)),
    avgCostUsd: avg(rows.map((row) => row.costUsd)),
    p50LatencyMs: percentile(rows.map((row) => row.completeMs), 0.5),
    p95LatencyMs: percentile(rows.map((row) => row.completeMs), 0.95),
    diffHashMatchRate: rateOf(rows, (row) => row.diffHashMatch),
    directParsedOkRate: rateOf(direct, (row) => row.parsedOk),
    directGitApplyOkRate: rateOf(direct, (row) => row.apply.ok),
    anomalies: unique(anomalies).slice(0, 20),
  };
}

function renderVerdict(args: {
  counts: CohortCounts;
  callsPlanned: number;
  callsMade: number;
  routes: readonly ReplayRoute[];
  summaries: readonly RouteSummary[];
  generatedAt: string;
}): string {
  const recommendation = pickRecommendation(args.summaries);
  const lines = [
    "# Virtuals Replay Verdict",
    "",
    `Generated: ${args.generatedAt}`,
    "",
    "## Cohort",
    "",
    `Migration-0029 token-gated cohort after rerunning \`apps/web/scripts/_check-eval-corpus.ts\`: total ${args.counts.total}, both-proposed ${args.counts.bothProposed}, opus-only ${args.counts.opusOnly}, gpt5-only ${args.counts.gpt5Only}, neither ${args.counts.neither}.`,
    "",
    `Virtuals calls: ${args.callsMade}/${args.callsPlanned} planned, hard cap ${MAX_CALLS}. No direct Anthropic/OpenAI calls were made by this probe.`,
    "",
    "Prompt caveat: prompts were reconstructed from current `reviews.agreement_decision` and PR file metadata. If a PR head moved since the historical run, prompt bytes may drift; this probe measures structural validity for the same finding shape, not byte-equivalence.",
    "",
    "## Headline",
    "",
    "| route | model | n | parsed_ok_rate | git_apply_ok_rate | refusal_rate | avg_prompt_tokens | avg_completion_tokens | avg_cost_usd | p50_latency_ms | p95_latency_ms | diff_hash_match_rate_vs_stored | direct_git_apply_ok_rate |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...args.summaries.map(
      (s) =>
        `| ${s.route.id} | ${s.route.resolvedModel} | ${s.n} | ${pct(s.parsedOkRate)} | ${pct(s.gitApplyOkRate)} | ${pct(s.refusalRate)} | ${num(s.avgPromptTokens, 0)} | ${num(s.avgCompletionTokens, 0)} | ${usd(s.avgCostUsd)} | ${num(s.p50LatencyMs, 0)} | ${num(s.p95LatencyMs, 0)} | ${pct(s.diffHashMatchRate)} | ${pct(s.directGitApplyOkRate)} |`,
    ),
    "",
    "## Per-Route Anomalies",
    "",
    ...args.summaries.flatMap((summary) => [
      `### ${summary.route.id}`,
      "",
      ...(summary.anomalies.length === 0 ? ["- None."] : summary.anomalies.map((a) => `- ${a}`)),
      "",
    ]),
    "## Recommendation",
    "",
    recommendation,
    "",
    "## Cost Extrapolation",
    "",
    ...args.summaries.map((summary) => {
      if (summary.avgCostUsd === null || summary.avgCostUsd <= 0) {
        return `- ${summary.route.id}: cost unavailable from streamed usage/pricing metadata; cannot extrapolate.`;
      }
      return `- ${summary.route.id}: avg ${usd(summary.avgCostUsd)} per call -> about ${Math.floor(VIRTUALS_WEEKLY_CREDIT_USD / summary.avgCostUsd).toLocaleString()} findings/week on $${VIRTUALS_WEEKLY_CREDIT_USD}.`;
    }),
    "",
  ];
  return lines.join("\n");
}

function pickRecommendation(summaries: readonly RouteSummary[]): string {
  if (summaries.some((summary) => summary.gitApplyOkRate < 0.5)) {
    return "**RED**: `git_apply_ok_rate < 50%` on at least one route. Do not use Virtuals for this prompt shape without another fix/probe cycle.";
  }
  if (summaries.some((summary) => summary.gitApplyOkRate < 0.8)) {
    return "**YELLOW**: parsing works, but apply rate is below the green threshold on at least one route. Eyeball a sample before spending the weekly credit.";
  }
  const baselineGap = summaries.some((summary) => {
    if (summary.directGitApplyOkRate <= 0) return false;
    return summary.gitApplyOkRate < summary.directGitApplyOkRate * 0.8;
  });
  if (baselineGap) {
    return "**YELLOW**: Virtuals cleared the absolute threshold but fell below 80% of stored direct's apply rate on at least one route.";
  }
  return "**GREEN** for retro-backfill: both routes met the structural apply threshold versus the stored direct baseline.";
}

function storedPatch(row: CohortRow, route: ReplayRoute): string | null {
  return route.storedColumn === "opus" ? row.suggestedPatchOpus : row.suggestedPatchGpt5;
}

function stripCodeFence(value: string): string {
  const match = /^```(?:json|diff)?\s*\n(?<body>[\s\S]*?)\n```$/u.exec(value);
  return match?.groups?.["body"]?.trim() ?? value;
}

function normalizeDiffText(patch: string): string {
  return patch.replace(/\r\n/gu, "\n").trim() + "\n";
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rateOf<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  if (values.length === 0) return 0;
  return values.filter(predicate).length / values.length;
}

function avg(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (present.length === 0) return null;
  return present.reduce((sum, value) => sum + value, 0) / present.length;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? null;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function num(value: number | null, digits: number): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(6)}`;
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function rowAt<T>(result: { rows?: unknown[] }): T {
  const row = result.rows?.[0];
  if (row === undefined) throw new Error("query returned no rows");
  return row as T;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      // Keep temp checkout cleanup explicit for short-lived operator probes.
    });
}
