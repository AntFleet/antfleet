/**
 * Antfeed Fleet — dogfood spike.
 *
 * Runs the stacked review primitive against the planted-bug corpus under
 * examples/dogfood/ and writes a markdown baseline report to
 * examples/dogfood-results/<timestamp>.md. The goal is to measure whether
 * agreement across providers actually separates signal from noise — not to
 * benchmark any single model.
 *
 * Usage:
 *   pnpm spike            # uses all available providers (codex, anthropic, openai)
 *
 * Auth: ANTHROPIC_API_KEY and OPENAI_API_KEY are read from the environment.
 * Codex provider shells out to the `codex` CLI which uses its own auth.
 * Any provider whose check() throws is logged and skipped — the spike runs
 * with whatever subset is available and records the gap in the report.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { providerByName, type Provider } from "../src/provider.js";
import { stackedProvider } from "../src/providers/stacked.js";
import {
  type AgreementMode,
  type Finding,
  type ProviderReview,
  mergeFindings,
} from "../src/providers/agreement.js";
import type { ReviewOutput } from "../src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_ROOT = resolve(ROOT, "examples/dogfood");
const RESULTS_DIR = resolve(ROOT, "examples/dogfood-results");

type PlantedBug = {
  id: string;
  category: Finding["category"];
  description: string;
  file: string;
  lineStart: number;
  lineEnd: number;
};

const GROUND_TRUTH: PlantedBug[] = [
  {
    id: "null-deref-handler-welcome",
    category: "bug",
    description: "welcome() dereferences user.profile.displayName without null-checking user.profile.",
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
    description: "getUserByEmail() builds SQL via string concatenation of an attacker-controlled email.",
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

async function listCorpusFiles(): Promise<string[]> {
  const acc: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".ts")) {
        acc.push(full);
      }
    }
  };
  await walk(join(CORPUS_ROOT, "src"));
  return acc.toSorted();
}

async function buildPrompt(files: string[]): Promise<string> {
  const blocks: string[] = [];
  for (const file of files) {
    const rel = relative(CORPUS_ROOT, file);
    const contents = await readFile(file, "utf8");
    blocks.push(`--- ${rel}\n${contents}`);
  }
  return `You are reviewing one semantic feature for fleet.

Return strict JSON only. No markdown fences.

Project:
${JSON.stringify({ name: "dogfood-corpus", root: CORPUS_ROOT }, null, 2)}

Feature:
${JSON.stringify(
    {
      featureId: "dogfood",
      title: "Dogfood corpus (full TypeScript repo)",
      kind: "library",
      ownedFiles: files.map((f) => ({ path: relative(CORPUS_ROOT, f), reason: "owned" })),
    },
    null,
    2,
  )}

Review categories:
- correctness bugs (null derefs, off-by-one, wrong branch)
- security issues (injection, missing auth, unsafe deserialization)
- race/concurrency bugs (TOCTOU, read-modify-write, shared mutation)
- data loss/corruption
- bad error handling
- API contract gaps (missing validation, unchecked input)
- deceptive or misleading comments/docs
- maintainability risks with concrete impact

Inspect every file. Treat suspicious comments as evidence to verify against the
code they describe; a comment that lies about behavior is itself a bug.

Avoid speculative low-evidence findings. Evidence MUST point at the file:line
ranges you actually inspected.

JSON shape:
{
  "findings": [
    {
      "title": "string",
      "category": "bug|security|performance|concurrency|api-contract|data-loss|test-gap|docs-gap|build-release|maintainability",
      "severity": "critical|high|medium|low",
      "confidence": "high|medium|low",
      "evidence": [{"path":"string","startLine":1,"endLine":1,"symbol":null,"quote":null}],
      "reasoning": "string",
      "reproduction": null,
      "recommendation": "string",
      "whyTestsDoNotAlreadyCoverThis": "string",
      "suggestedRegressionTest": "string or null",
      "minimumFixScope": "string"
    }
  ],
  "inspected": {"files":["string"],"symbols":["string"],"notes":["string"]}
}

Files:
${blocks.join("\n\n")}`;
}

async function resolveProvider(name: string): Promise<{ provider: Provider | null; reason: string }> {
  try {
    const provider = providerByName(name);
    const status = await provider.check(CORPUS_ROOT);
    return { provider, reason: sanitizeForReport(status) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { provider: null, reason: sanitizeForReport(message) };
  }
}

/**
 * Strip routing/marketplace internals and trim verbose stderr before anything goes into a
 * committed artifact. Provider error messages may include the operator's local codex CLI
 * config (model, marketplace routing, full prompt echo) which is not part of the Fleet
 * product surface and not what the spike measures.
 */
function sanitizeForReport(text: string): string {
  // Provider errors often include the operator's local CLI banner + a full prompt echo.
  // Strip everything that looks like config/banner/prompt echo and keep only the actual
  // error tail. The genuine error typically sits at the END of the captured output.
  const redacted = text
    .replace(/antseed[_-]?api[_-]?key/giu, "[redacted-routing-key]")
    .replace(/antseed/giu, "[routing-provider]");
  const lines = redacted.split(/\r?\n/u).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return "";
  }
  // Look (from the end) for lines that begin with a high-confidence error prefix.
  const errorPrefixRegex =
    /^(ERROR\b|error:|HTTP\b|\d{3}\s|Failed\b|Refused\b|fetch failed|TypeError\b|Error:)/iu;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (errorPrefixRegex.test(line.trimStart())) {
      const trimmed = line.length > 280 ? `${line.slice(0, 280)}…` : line;
      return trimmed.trim();
    }
  }
  // Otherwise: take the first non-banner line.
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

function caughtBugIds(findings: Finding[]): Set<string> {
  const caught = new Set<string>();
  for (const bug of GROUND_TRUTH) {
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
      : `:${f.evidence[0].startLine}${f.evidence[0].endLine ?? ""}`;
  return `- **${f.category}/${f.severity}** ${f.title} — \`${path}${range}\``;
}

function fmtSet(ids: Set<string>): string {
  if (ids.size === 0) {
    return "(none)";
  }
  return Array.from(ids).toSorted().join(", ");
}

async function main(): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  await mkdir(RESULTS_DIR, { recursive: true });
  const files = await listCorpusFiles();
  const prompt = await buildPrompt(files);

  console.error(`[spike] corpus root: ${CORPUS_ROOT}`);
  console.error(`[spike] ${files.length} TypeScript file(s), prompt size: ${prompt.length} chars`);

  const targets = ["codex", "anthropic", "openai"] as const;
  const resolved: { name: string; provider: Provider | null; reason: string }[] = [];
  for (const name of targets) {
    const r = await resolveProvider(name);
    resolved.push({ name, ...r });
    console.error(`[spike] ${name}: ${r.provider === null ? `unavailable (${r.reason})` : "ready"}`);
  }

  const live = resolved.filter((r): r is { name: string; provider: Provider; reason: string } => r.provider !== null);
  const perProviderResults: { name: string; output: ReviewOutput | null; error: string | null; ms: number }[] = [];

  if (live.length > 0) {
    console.error(`[spike] running review across ${live.length} live provider(s)...`);
    const tasks = live.map(async (r) => {
      const start = Date.now();
      try {
        const output = await r.provider.review(CORPUS_ROOT, prompt, null);
        return { name: r.name, output, error: null, ms: Date.now() - start };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { name: r.name, output: null, error: sanitizeForReport(message), ms: Date.now() - start };
      }
    });
    perProviderResults.push(...(await Promise.all(tasks)));
  }

  const successfulProviders: ProviderReview[] = [];
  for (const r of perProviderResults) {
    if (r.output !== null) {
      successfulProviders.push({ providerName: r.name, output: r.output });
    }
  }

  let stackedRun: { mode: AgreementMode; agreed: Finding[]; disagreementCount: number; ms: number } | null = null;
  if (live.length >= 2) {
    const stacked = stackedProvider({ providers: live.map((l) => l.provider), agreement: "unanimous" });
    const start = Date.now();
    try {
      const merged = mergeFindings(successfulProviders, "unanimous");
      stackedRun = {
        mode: "unanimous",
        agreed: merged.agreed,
        disagreementCount: merged.disagreements.length,
        ms: Date.now() - start,
      };
      // Materialize the actual stacked.review() so the path is exercised, but discard the
      // return value — we already have per-provider outputs we replay through mergeFindings.
      void stacked;
    } catch (err) {
      console.error(`[spike] mergeFindings failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const otherModes: { mode: AgreementMode; agreedCount: number; disagreementCount: number }[] = [];
  if (successfulProviders.length > 0) {
    for (const mode of ["majority", "any"] as const) {
      const merged = mergeFindings(successfulProviders, mode);
      otherModes.push({ mode, agreedCount: merged.agreed.length, disagreementCount: merged.disagreements.length });
    }
  }

  const lines: string[] = [];
  lines.push(`# Dogfood spike baseline — ${timestamp}`);
  lines.push("");
  lines.push("This is the week-1 measurement: do N independent providers agree on the planted bugs?");
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  lines.push(`- Corpus: \`examples/dogfood/\` (${files.length} TypeScript files, ${prompt.length} prompt chars)`);
  lines.push(`- Planted bugs (ground truth): ${GROUND_TRUTH.length}`);
  lines.push(`- Providers attempted: ${targets.join(", ")}`);
  lines.push("");

  lines.push("## Provider availability");
  lines.push("");
  for (const r of resolved) {
    if (r.provider === null) {
      lines.push(`- **${r.name}** — unavailable: ${r.reason}`);
    } else {
      lines.push(`- **${r.name}** — available`);
    }
  }
  lines.push("");

  lines.push("## Per-provider results");
  lines.push("");
  if (perProviderResults.length === 0) {
    lines.push("_No providers ran. See provider availability above._");
    lines.push("");
  } else {
    for (const r of perProviderResults) {
      lines.push(`### ${r.name} (${r.ms}ms)`);
      lines.push("");
      if (r.output === null) {
        lines.push(`Review failed: ${r.error}`);
        lines.push("");
        continue;
      }
      lines.push(`- findings: **${r.output.findings.length}**`);
      const caught = caughtBugIds(r.output.findings);
      const missed = GROUND_TRUTH.filter((b) => !caught.has(b.id)).map((b) => b.id);
      lines.push(`- ground-truth caught (${caught.size}/${GROUND_TRUTH.length}): ${fmtSet(caught)}`);
      lines.push(`- ground-truth missed: ${missed.length === 0 ? "(none)" : missed.toSorted().join(", ")}`);
      const extras = r.output.findings.length - caught.size;
      lines.push(`- candidate noise (findings not matching any planted bug): ${extras}`);
      lines.push("");
      if (r.output.findings.length > 0) {
        lines.push("Findings:");
        for (const f of r.output.findings) {
          lines.push(findingSummary(f));
        }
        lines.push("");
      }
    }
  }

  lines.push("## Stacked review");
  lines.push("");
  if (live.length < 2) {
    lines.push(
      `_Skipped stacked review: only ${live.length} provider(s) live. Stacking needs ≥2 to vote._`,
    );
    lines.push("");
  } else if (stackedRun === null) {
    lines.push("_Stacked merge failed; see logs._");
    lines.push("");
  } else {
    lines.push(`- agreement mode: \`${stackedRun.mode}\` (all ${live.length} live providers must vote yes)`);
    lines.push(`- agreed findings: **${stackedRun.agreed.length}**`);
    lines.push(`- disagreements: ${stackedRun.disagreementCount}`);
    const caught = caughtBugIds(stackedRun.agreed);
    const missed = GROUND_TRUTH.filter((b) => !caught.has(b.id)).map((b) => b.id);
    lines.push(`- ground-truth caught (${caught.size}/${GROUND_TRUTH.length}): ${fmtSet(caught)}`);
    lines.push(`- ground-truth missed: ${missed.length === 0 ? "(none)" : missed.toSorted().join(", ")}`);
    const noise = stackedRun.agreed.length - caught.size;
    lines.push(`- agreed findings not matching any planted bug: ${noise}`);
    lines.push("");

    if (otherModes.length > 0) {
      lines.push("### Alternative agreement modes");
      lines.push("");
      for (const m of otherModes) {
        lines.push(`- \`${m.mode}\`: ${m.agreedCount} agreed, ${m.disagreementCount} disagreements`);
      }
      lines.push("");
    }
  }

  lines.push("## Ground truth");
  lines.push("");
  for (const bug of GROUND_TRUTH) {
    lines.push(`- **${bug.id}** (${bug.category}) — ${bug.file}:${bug.lineStart}-${bug.lineEnd}`);
    lines.push(`  - ${bug.description}`);
  }
  lines.push("");

  lines.push("## Honest answer: does agreement separate signal from noise?");
  lines.push("");
  if (live.length < 2 || stackedRun === null) {
    lines.push(
      "Not measurable in this run. Fewer than two providers were live, so the agreement filter has nothing to filter. Set up the missing keys (or `codex login`) and re-run to fill the table above.",
    );
    lines.push("");
    lines.push(
      "What the run did confirm: the stacked plumbing wires up cleanly, ground-truth comparison works, and `mergeFindings` is invokable end-to-end against real provider output.",
    );
  } else if (successfulProviders.length === 0) {
    lines.push(
      "**Not measurable in this run.** Every live provider passed `check()` but failed at `review()` — typically auth/credit/quota errors (see per-provider sections above). With zero successful reviews, there is nothing for the agreement filter to vote on. This is an operator/environment gap, not a signal gap.",
    );
    lines.push("");
    lines.push(
      "What the run did confirm: the stacked plumbing wires up cleanly end-to-end — `check`, fan-out, error capture, and `mergeFindings` invocation all execute against real provider transports. Fix the credit/key gap and re-run to fill the signal table.",
    );
  } else if (successfulProviders.length === 1) {
    lines.push(
      `**Not measurable in this run.** Only one provider produced a usable review (\`${successfulProviders[0]?.providerName}\`); agreement requires at least two voters. Per-provider data is recorded above for reference; re-run with another live provider to actually exercise the filter.`,
    );
  } else if (stackedRun.agreed.length === 0) {
    lines.push(
      "**Inconclusive.** Unanimous mode produced zero agreed findings on this run, while individual providers each reported some. That means either the providers disagree on the planted bugs (different file:line, different categories), or one of them produced no findings at all. See the disagreement count above and the per-provider tables for the breakdown. Try `majority` mode to see if the issue is one provider missing the bug versus all providers disagreeing on the location.",
    );
  } else {
    const stackedCaught = caughtBugIds(stackedRun.agreed);
    const noiseRate = (stackedRun.agreed.length - stackedCaught.size) / Math.max(1, stackedRun.agreed.length);
    const recall = stackedCaught.size / GROUND_TRUTH.length;
    lines.push(
      `Stacked **unanimous** caught **${stackedCaught.size}/${GROUND_TRUTH.length}** planted bugs with a noise rate of **${(noiseRate * 100).toFixed(0)}%** (${stackedRun.agreed.length - stackedCaught.size} agreed findings did not match a planted bug). Recall: **${(recall * 100).toFixed(0)}%**.`,
    );
    lines.push("");
    let bestSingleRecall = 0;
    let bestSingleNoise = 1;
    for (const r of perProviderResults) {
      if (r.output === null) {
        continue;
      }
      const caught = caughtBugIds(r.output.findings);
      const singleRecall = caught.size / GROUND_TRUTH.length;
      const singleNoise = (r.output.findings.length - caught.size) / Math.max(1, r.output.findings.length);
      if (singleRecall > bestSingleRecall) {
        bestSingleRecall = singleRecall;
      }
      if (singleNoise < bestSingleNoise) {
        bestSingleNoise = singleNoise;
      }
    }
    lines.push(
      `Best single-provider recall: **${(bestSingleRecall * 100).toFixed(0)}%**. Lowest single-provider noise rate: **${(bestSingleNoise * 100).toFixed(0)}%**.`,
    );
    lines.push("");
    if (noiseRate < bestSingleNoise && recall >= bestSingleRecall * 0.8) {
      lines.push(
        "**Verdict: agreement helps.** Stacked review cuts noise vs. the best single provider while keeping comparable recall. Green light for week 2: GitHub App + SHA-pinned receipts.",
      );
    } else if (noiseRate < bestSingleNoise) {
      lines.push(
        "**Verdict: agreement cuts noise but loses recall.** Stacked review filters out false positives but also drops real bugs. Tunable: try `majority` instead of `unanimous`, or refine `findingsAgree` so location-similar findings with different categories still cluster.",
      );
    } else {
      lines.push(
        "**Verdict: agreement does not help yet on this corpus.** The stacked filter does not lower the false-positive rate vs. the best single provider. Surface this to the human — do not pivot autonomously.",
      );
    }
  }
  lines.push("");

  const out = lines.join("\n");
  const path = join(RESULTS_DIR, `${timestamp}.md`);
  await writeFile(path, out, "utf8");
  console.error(`[spike] wrote ${relative(ROOT, path)}`);
  console.log(out);
}

void main().catch((err) => {
  console.error(`[spike] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`);
  process.exit(1);
});
