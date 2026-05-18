/**
 * AntFleet — dogfood spike runner.
 *
 * Runs N independent stacked reviews against the planted-bug corpus under
 * examples/dogfood/ and writes one markdown report per run to
 * examples/dogfood-results/run-<i>-<timestamp>.md. A single-run invocation
 * writes one timestamped file as before; the committed baseline lives at
 * examples/dogfood-results/spike-baseline.md.
 *
 * Usage:
 *   pnpm spike --runs 5 --providers anthropic,openai,openrouter --mode unanimous
 *   pnpm spike --providers anthropic,openrouter --runs 3 --ceiling 2
 *
 * Loads ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY from .env.local
 * (gitignored, mode 600). Provider error output is sanitized before it is
 * written to the report -- any "sk-" key fragment is redacted, and operator-
 * local routing internals are stripped.
 *
 * Hard cost ceiling: default $5 across all runs. Crossing it aborts the next
 * run before it starts; runs that have already completed are kept.
 */

import { config as loadDotenv } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { providerByName, type Provider } from "../src/provider.js";
import { stackedProvider } from "../src/providers/stacked.js";
import {
  type AgreementMode,
  type Finding,
  type ProviderReview,
  mergeFindings,
} from "../src/providers/agreement.js";
import type { ReviewOutput } from "../src/types.js";
import { parseSpikeArgs } from "../src/spike/cli.js";
import { estimateRunCost, shouldAbortBeforeRun } from "../src/spike/cost.js";
import { buildSpikePrompt } from "../src/spike/build-prompt.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CORPUS = resolve(ROOT, "examples/dogfood");
// v1 default stack: two independent frontier providers, unanimous agreement.
// See ARCHITECTURE.md §Provider roster for why openrouter/codex are deferred.
const DEFAULT_PROVIDERS = ["anthropic", "openai"] as const;
// Source-file extensions the walker considers. Mirrors apps/web/lib/
// github-files.ts REVIEW_EXTENSIONS so the spike corpus reflects what the
// production webhook handler would actually pull in. The dogfood corpus is
// .ts-only so this remains a strict superset for that fixture.
const SOURCE_EXTENSIONS: readonly string[] = [
  ".cjs",
  ".go",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sol",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
];

loadDotenv({ path: resolve(ROOT, ".env.local"), quiet: true });

type PlantedBug = {
  id: string;
  category: Finding["category"];
  description: string;
  file: string;
  lineStart: number;
  lineEnd: number;
};

/** Default (dogfood) ground truth used when a corpus does not ship its own. */
const DOGFOOD_GROUND_TRUTH: PlantedBug[] = [
  {
    id: "null-deref-handler-welcome",
    category: "bug",
    description:
      "welcome() dereferences user.profile.displayName without null-checking user.profile.",
    file: "src/handler.ts",
    lineStart: 5,
    lineEnd: 7,
  },
  {
    id: "input-validation-handler-deletePost",
    category: "api-contract",
    description:
      "deletePost() casts req.body to a typed shape without runtime validation and performs no authorization check.",
    file: "src/handler.ts",
    lineStart: 10,
    lineEnd: 14,
  },
  {
    id: "sql-injection-db",
    category: "security",
    description:
      "getUserByEmail() builds SQL via string concatenation of an attacker-controlled email.",
    file: "src/db.ts",
    lineStart: 5,
    lineEnd: 8,
  },
  {
    id: "race-condition-counter-bulk",
    category: "concurrency",
    description:
      "bulkIncrement() launches parallel read-modify-write increments; concurrent reads see stale values and writes clobber each other.",
    file: "src/counter.ts",
    lineStart: 33,
    lineEnd: 44,
  },
  {
    id: "deceptive-comment-format-escapeHtml",
    category: "security",
    description:
      "escapeHtml() comment claims to escape <, >, &, \", and ' but the implementation only handles < and >. Callers relying on the docstring are vulnerable.",
    file: "src/format.ts",
    lineStart: 1,
    lineEnd: 10,
  },
];

/**
 * Load the ground truth for a corpus. A corpus may ship a `.ground-truth.json`
 * file at its root (array of PlantedBug entries); if present it overrides the
 * dogfood default. The file is gitignored alongside other ground-truth
 * artifacts so a corpus can hold real-world bug data without committing it.
 */
async function loadGroundTruth(corpusRoot: string): Promise<PlantedBug[]> {
  const path = join(corpusRoot, ".ground-truth.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as PlantedBug[];
  } catch {
    return DOGFOOD_GROUND_TRUTH;
  }
}

async function listCorpusFiles(corpusRoot: string): Promise<string[]> {
  const acc: string[] = [];
  const skipDirs = new Set(["node_modules", "dist", "build", ".git", ".fleet"]);
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip dot-files (incl. corpus-local .ground-truth.json) and known
      // build/output directories. The ground truth must never reach the LLM.
      if (entry.name.startsWith(".") || skipDirs.has(entry.name)) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        acc.push(full);
      }
    }
  };
  await walk(corpusRoot);
  return acc.toSorted();
}

async function buildPrompt(corpusRoot: string, files: string[]): Promise<string> {
  const inputs = await Promise.all(
    files.map(async (f) => ({
      path: relative(corpusRoot, f),
      contents: await readFile(f, "utf8"),
    })),
  );
  return buildSpikePrompt({
    projectName: "corpus",
    projectRoot: corpusRoot,
    featureId: "corpus",
    featureTitle: "Corpus (full TypeScript source)",
    files: inputs,
  });
}

async function resolveProvider(
  name: string,
  corpusRoot: string,
): Promise<{ name: string; provider: Provider | null; reason: string }> {
  try {
    const provider = providerByName(name);
    const status = await provider.check(corpusRoot);
    return { name, provider, reason: sanitizeForReport(status) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name, provider: null, reason: sanitizeForReport(message) };
  }
}

/**
 * Sanitize text that may end up in a committed report. Three jobs:
 *   1. Redact any sk- key fragment that leaked into an error message.
 *   2. Strip operator-local marketplace/routing strings.
 *   3. Trim verbose stderr (codex echoes the full prompt) to the actual error.
 */
function sanitizeForReport(text: string): string {
  const redacted = text.replace(/sk-[A-Za-z0-9_-]{20,}/gu, "[REDACTED]");
  const lines = redacted.split(/\r?\n/u).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return "";
  }
  const errorPrefixRegex =
    /^(ERROR\b|error:|HTTP\b|\d{3}\s|Failed\b|Refused\b|fetch failed|TypeError\b|Error:)/iu;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (errorPrefixRegex.test(line.trimStart())) {
      const trimmed = line.length > 280 ? `${line.slice(0, 280)}…` : line;
      return trimmed.trim();
    }
  }
  const bannerRegex =
    /^(workdir:|model:|provider:|approval:|sandbox:|reasoning|session id|user$|---|OpenAI Codex|Codex CLI|\* )/iu;
  for (const line of lines) {
    if (!bannerRegex.test(line.trim())) {
      const trimmed = line.length > 280 ? `${line.slice(0, 280)}…` : line;
      return trimmed.trim();
    }
  }
  const fallback = lines[lines.length - 1] ?? "";
  return fallback.length > 280 ? `${fallback.slice(0, 280)}…` : fallback;
}

function matchesGroundTruth(finding: Finding, bug: PlantedBug): boolean {
  for (const evidence of finding.evidence) {
    if (!evidence.path.endsWith(bug.file)) {
      continue;
    }
    const start = evidence.startLine ?? 0;
    const end = evidence.endLine ?? start;
    if (start <= bug.lineEnd && end >= bug.lineStart) {
      return true;
    }
    if (evidence.startLine === null && evidence.endLine === null) {
      return true;
    }
  }
  return false;
}

function caughtBugIds(findings: Finding[], groundTruth: PlantedBug[]): Set<string> {
  const caught = new Set<string>();
  for (const bug of groundTruth) {
    if (findings.some((f) => matchesGroundTruth(f, bug))) {
      caught.add(bug.id);
    }
  }
  return caught;
}

function findingSummary(f: Finding): string {
  const path = f.evidence[0]?.path ?? "(no evidence)";
  const range =
    f.evidence[0]?.startLine === undefined || f.evidence[0]?.startLine === null
      ? ""
      : `:${f.evidence[0].startLine}-${f.evidence[0].endLine ?? f.evidence[0].startLine}`;
  return `- **${f.category}/${f.severity}** ${f.title} — \`${path}${range}\``;
}

function fmtSet(ids: Set<string>): string {
  if (ids.size === 0) {
    return "(none)";
  }
  return Array.from(ids).toSorted().join(", ");
}

type PerProviderResult = {
  name: string;
  output: ReviewOutput | null;
  error: string | null;
  ms: number;
};

type RunResult = {
  runIndex: number;
  timestamp: string;
  reportPath: string;
  liveProviderNames: string[];
  perProvider: PerProviderResult[];
  agreedCount: number;
  agreedCaughtIds: string[];
  agreedTitles: string[];
  modes: {
    mode: AgreementMode;
    agreedCount: number;
    disagreementCount: number;
    agreedTitles: string[];
  }[];
  durationMs: number;
  estimatedCostUsd: number;
};

async function runOne(args: {
  runIndex: number;
  totalRuns: number;
  prompt: string;
  files: string[];
  providers: { name: string; provider: Provider }[];
  primaryMode: AgreementMode;
  corpusRoot: string;
  resultsDir: string;
  groundTruth: PlantedBug[];
}): Promise<RunResult> {
  const start = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const tasks = args.providers.map(async (p) => {
    const t0 = Date.now();
    try {
      const output = await p.provider.review(args.corpusRoot, args.prompt, null);
      return { name: p.name, output, error: null, ms: Date.now() - t0 } satisfies PerProviderResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: p.name,
        output: null,
        error: sanitizeForReport(message),
        ms: Date.now() - t0,
      } satisfies PerProviderResult;
    }
  });
  const perProvider = await Promise.all(tasks);
  const successful: ProviderReview[] = [];
  for (const r of perProvider) {
    if (r.output !== null) {
      successful.push({ providerName: r.name, output: r.output });
    }
  }

  const modes: RunResult["modes"] = [];
  for (const mode of ["unanimous", "majority", "any"] as const) {
    const merged = mergeFindings(successful, mode);
    modes.push({
      mode,
      agreedCount: merged.agreed.length,
      disagreementCount: merged.disagreements.length,
      agreedTitles: merged.agreed.map((f) => f.title),
    });
  }
  const primary = modes.find((m) => m.mode === args.primaryMode);
  const merged = mergeFindings(successful, args.primaryMode);
  const agreedCaught = caughtBugIds(merged.agreed, args.groundTruth);

  // Materialize the actual stackedProvider so its instantiation path is exercised.
  if (successful.length >= 2) {
    void stackedProvider({
      providers: args.providers.map((p) => p.provider),
      agreement: args.primaryMode,
    });
  }

  // Per-run report
  const lines: string[] = [];
  const corpusName = args.corpusRoot.split("/").pop() ?? "corpus";
  lines.push(
    `# Fleet spike (${corpusName}) — run ${args.runIndex}/${args.totalRuns} — ${timestamp}`,
  );
  lines.push("");
  lines.push(`- Mode: \`${args.primaryMode}\``);
  lines.push(
    `- Live providers: ${args.providers.map((p) => p.name).join(", ") || "(none)"} (${args.providers.length})`,
  );
  lines.push(`- Successful reviews: ${successful.length}/${args.providers.length}`);
  lines.push(`- Planted bugs (ground truth): ${args.groundTruth.length}`);
  lines.push("");

  lines.push("## Per-provider");
  lines.push("");
  for (const r of perProvider) {
    lines.push(`### ${r.name} (${r.ms}ms)`);
    lines.push("");
    if (r.output === null) {
      lines.push(`Review failed: ${r.error}`);
      lines.push("");
      continue;
    }
    const caught = caughtBugIds(r.output.findings, args.groundTruth);
    const missed = args.groundTruth.filter((b) => !caught.has(b.id)).map((b) => b.id);
    lines.push(`- findings: **${r.output.findings.length}**`);
    lines.push(
      `- ground-truth caught (${caught.size}/${args.groundTruth.length}): ${fmtSet(caught)}`,
    );
    lines.push(
      `- ground-truth missed: ${missed.length === 0 ? "(none)" : missed.toSorted().join(", ")}`,
    );
    lines.push(
      `- candidate noise (findings not matching any planted bug): ${r.output.findings.length - caught.size}`,
    );
    if (r.output.findings.length > 0) {
      lines.push("");
      lines.push("Findings:");
      for (const f of r.output.findings) {
        lines.push(findingSummary(f));
      }
    }
    lines.push("");
  }

  lines.push("## Agreement modes");
  lines.push("");
  for (const m of modes) {
    const caught = caughtBugIds(mergeFindings(successful, m.mode).agreed, args.groundTruth);
    const tag = m.mode === args.primaryMode ? " (primary)" : "";
    lines.push(
      `- \`${m.mode}\`${tag}: ${m.agreedCount} agreed, ${m.disagreementCount} disagreements, caught ${caught.size}/${args.groundTruth.length}`,
    );
  }
  lines.push("");

  if (primary !== undefined) {
    lines.push(`## Primary mode (${args.primaryMode}) — agreed findings`);
    lines.push("");
    if (primary.agreedTitles.length === 0) {
      lines.push("(none)");
    } else {
      for (const f of merged.agreed) {
        lines.push(findingSummary(f));
      }
    }
    lines.push("");
  }

  const reportPath = join(args.resultsDir, `run-${args.runIndex}-${timestamp}.md`);
  await writeFile(reportPath, lines.join("\n"), "utf8");

  const estimatedCostUsd = estimateRunCost(args.providers.map((p) => p.name));
  return {
    runIndex: args.runIndex,
    timestamp,
    reportPath,
    liveProviderNames: args.providers.map((p) => p.name),
    perProvider,
    agreedCount: primary?.agreedCount ?? 0,
    agreedCaughtIds: Array.from(agreedCaught).toSorted(),
    agreedTitles: primary?.agreedTitles ?? [],
    modes,
    durationMs: Date.now() - start,
    estimatedCostUsd,
  };
}

async function main(): Promise<void> {
  const args = parseSpikeArgs(process.argv.slice(2));
  const corpusRoot = args.corpus === null ? DEFAULT_CORPUS : resolve(ROOT, args.corpus);
  const resultsDir = `${corpusRoot}-results`;
  await mkdir(resultsDir, { recursive: true });
  const files = await listCorpusFiles(corpusRoot);
  const prompt = await buildPrompt(corpusRoot, files);
  const groundTruth = await loadGroundTruth(corpusRoot);

  console.error(`[spike] corpus root: ${corpusRoot}`);
  console.error(`[spike] ${files.length} source file(s), prompt size: ${prompt.length} chars`);
  console.error(`[spike] ground truth: ${groundTruth.length} bug(s)`);
  console.error(
    `[spike] runs=${args.runs}, mode=${args.mode}, ceiling=$${args.costCeilingUsd.toFixed(2)}`,
  );

  const targetNames = args.providers ?? [...DEFAULT_PROVIDERS];
  console.error(`[spike] target providers: ${targetNames.join(", ")}`);

  const resolved = [];
  for (const name of targetNames) {
    resolved.push(await resolveProvider(name, corpusRoot));
  }
  const live = resolved
    .filter((r): r is { name: string; provider: Provider; reason: string } => r.provider !== null)
    .map((r) => ({ name: r.name, provider: r.provider }));

  for (const r of resolved) {
    console.error(
      `[spike] ${r.name}: ${r.provider === null ? `unavailable (${r.reason})` : "ready"}`,
    );
  }

  if (live.length === 0) {
    console.error("[spike] no live providers; nothing to run");
    return;
  }

  const perRunCost = estimateRunCost(live.map((l) => l.name));
  console.error(
    `[spike] estimated cost per run: $${perRunCost.toFixed(3)} across ${live.length} provider(s)`,
  );

  let cumulativeCost = 0;
  const runs: RunResult[] = [];
  let abortedAfter: number | null = null;

  for (let i = 1; i <= args.runs; i++) {
    const ceiling = shouldAbortBeforeRun(cumulativeCost, perRunCost, args.costCeilingUsd);
    if (ceiling.abort) {
      console.error(`[spike] aborting before run ${i}/${args.runs}: ${ceiling.reason}`);
      abortedAfter = i - 1;
      break;
    }
    console.error(`[spike] starting run ${i}/${args.runs} (${ceiling.reason})`);
    const result = await runOne({
      runIndex: i,
      totalRuns: args.runs,
      prompt,
      files,
      providers: live,
      primaryMode: args.mode,
      corpusRoot,
      resultsDir,
      groundTruth,
    });
    runs.push(result);
    cumulativeCost += result.estimatedCostUsd;
    console.error(
      `[spike] run ${i}/${args.runs} done in ${result.durationMs}ms (cumulative est. cost: $${cumulativeCost.toFixed(3)})`,
    );
    console.error(
      `[spike]   wrote ${relative(ROOT, result.reportPath)} (agreed=${result.agreedCount}, caught=${result.agreedCaughtIds.length}/${groundTruth.length})`,
    );
  }

  console.error(
    `[spike] complete: ${runs.length}/${args.runs} runs, $${cumulativeCost.toFixed(3)} estimated${abortedAfter === null ? "" : ` (aborted after run ${abortedAfter})`}`,
  );

  if (runs.length === 0) {
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error(`[spike] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  process.exit(1);
});
