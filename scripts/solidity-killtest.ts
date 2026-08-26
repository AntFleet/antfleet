/**
 * §2 KILL-TEST RUNNER — Solidity full-contract audit premise test.
 * specs/SOLIDITY_AUDIT_MODE_SPEC.md
 *
 * This is a SIDECAR (§0): it reuses the provider registry and cost helpers but
 * does NOT touch review-worker / review-pipeline / chunk-repo-for-bench. The
 * PR-diff reviewer is not exercised or modified here beyond calling its
 * existing prompt builder + provider.review() as the BASELINE arm.
 *
 * Layout per labeled target:
 *
 *   solidity-killtest/targets/<name>/
 *     manifest.json        <- targetManifestSchema (known answer + program rules)
 *     contracts/**.sol     <- the codebase at the vulnerable commit
 *
 * Usage:
 *   pnpm killtest                          # all targets, anthropic only
 *   pnpm killtest --providers anthropic,openai
 *   pnpm killtest --targets-dir <dir> --ceiling 10
 *
 * For each target:
 *   ARM 1 (baseline) : pack files into ≤150KB slices (mirroring the PR chunker),
 *                      run buildSpikePrompt + provider.review() per slice.
 *   ARM 2 (new mode) : resolve the whole-contract import/inheritance closure,
 *                      run the fund-extraction objective + program rules via
 *                      one raw model call, parse leniently, score PURSUE/DROP.
 * Then evaluateTarget() + evaluateGate() and write a report.
 *
 * COST: hard ceiling across both arms of every target (default $10). Crossing
 * it aborts before the next unit; completed units are kept.
 */

import { config as loadDotenv } from "dotenv";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerByName } from "../src/provider.js";
import { estimateCallCost, shouldAbortBeforeRun } from "../src/spike/cost.js";
import { buildSpikePrompt, type PromptFile } from "../src/spike/build-prompt.js";
import {
  DEFAULT_MAX_SLICE_BYTES,
  packSlices,
  resolveContractClosure,
  type ContextFile,
} from "../src/sidecar-solidity/context.js";
import { AUDIT_DEFAULT_MODEL, auditModelCall } from "../src/sidecar-solidity/model-client.js";
import { buildFullContractAuditPrompt } from "../src/sidecar-solidity/prompt.js";
import {
  auditOutputSchema,
  evaluateGate,
  evaluateTarget,
  targetManifestSchema,
  type GateDecision,
  type KnownBug,
  type Severity,
  type TargetOutcome,
  type TargetManifest,
} from "../src/sidecar-solidity/killtest.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGETS_DIR = resolve(ROOT, "solidity-killtest/targets");
const RESULTS_DIR = resolve(ROOT, "solidity-killtest/results");

loadDotenv({ path: resolve(ROOT, ".env.local"), quiet: true });

const SOURCE_EXTENSIONS = [".sol"] as const;

type CliArgs = {
  targetsDir: string;
  providers: string[];
  ceilingUsd: number;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    targetsDir: DEFAULT_TARGETS_DIR,
    providers: ["anthropic"],
    ceilingUsd: 10,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? "";
    const take = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--targets-dir") {
      args.targetsDir = resolve(take());
      i += 2;
      continue;
    }
    if (arg === "--providers") {
      const list = take()
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (list.length === 0) throw new Error("--providers must be non-empty");
      args.providers = list;
      i += 2;
      continue;
    }
    if (arg === "--ceiling") {
      args.ceilingUsd = Number.parseFloat(take());
      i += 2;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.error("usage: killtest [--targets-dir DIR] [--providers a,b] [--ceiling USD]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function listSourceFiles(root: string): Promise<string[]> {
  const acc: string[] = [];
  const skipDirs = new Set(["node_modules", "lib", "out", "cache", ".git", ".fleet"]);
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip dot-files and build dirs. The manifest must never reach the LLM.
      if (entry.name.startsWith(".") || skipDirs.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        acc.push(full);
      }
    }
  };
  await walk(root);
  return acc.toSorted();
}

async function readContextFiles(
  targetRoot: string,
  paths: readonly string[],
): Promise<ContextFile[]> {
  return Promise.all(
    paths.map(async (p) => ({
      path: relative(targetRoot, p),
      contents: await readFile(p, "utf8"),
    })),
  );
}

async function loadManifests(targetsDir: string): Promise<{ name: string; root: string }[]> {
  const entries = await readdir(targetsDir, { withFileTypes: true });
  const out: { name: string; root: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(targetsDir, entry.name, "manifest.json");
    try {
      await readFile(manifestPath, "utf8");
      out.push({ name: entry.name, root: join(targetsDir, entry.name) });
    } catch {
      // Directory without a manifest is not a target; ignore silently.
    }
  }
  return out;
}

async function runBaselineArm(args: {
  providerName: string;
  targetRoot: string;
  files: ContextFile[];
  sliceFindingsSink: BaselineFinding[];
}): Promise<void> {
  const provider = providerByName(args.providerName);
  await provider.check(args.targetRoot);
  const slices = packSlices(args.files, DEFAULT_MAX_SLICE_BYTES);
  for (const slice of slices) {
    const prompt = buildSpikePrompt({
      projectName: "killtest-baseline",
      projectRoot: args.targetRoot,
      featureId: `slice-${slice.index}`,
      featureTitle: `Slice ${slice.index} (${slice.files.length} file(s), ${slice.bytes} bytes)`,
      files: slice.files satisfies PromptFile[],
    });
    const output = await provider.review(args.targetRoot, prompt, null);
    for (const finding of output.findings) {
      args.sliceFindingsSink.push(finding);
    }
  }
}

type BaselineFinding = {
  title: string;
  category: unknown;
  severity: Severity;
  confidence: string;
  evidence: { path: string; startLine: number | null; endLine: number | null }[];
  reasoning: string;
};

async function runAuditArm(args: {
  targetRoot: string;
  manifest: TargetManifest;
  files: ContextFile[];
}): Promise<{ findings: ReturnType<typeof auditOutputSchema.parse>["findings"]; model: string }> {
  const availablePaths = args.files.map((f) => f.path);
  // Union of closures over every declared entry contract = Mode-A context.
  const closurePaths = new Set<string>();
  const externals = new Set<string>();
  for (const entry of args.manifest.entryContracts) {
    if (!availablePaths.includes(entry)) {
      throw new Error(`entry contract ${entry} not found in target tree`);
    }
    const closure = await resolveContractClosure(entry, availablePaths, async (rel) => {
      const abs = join(args.targetRoot, rel);
      return readFile(abs, "utf8");
    });
    for (const p of closure.included) closurePaths.add(p);
    for (const e of closure.external) externals.add(e);
  }
  const contextFiles = args.files.filter((f) => closurePaths.has(f.path));
  if (externals.size > 0) {
    console.warn(
      `[killtest] WARNING: unresolved external imports (closure incomplete): ${[...externals].join(", ")}`,
    );
  }
  const prompt = buildFullContractAuditPrompt({
    projectName: args.manifest.name,
    entryContracts: args.manifest.entryContracts,
    files: contextFiles,
    programRules: args.manifest.programRules,
  });
  const raw = await auditModelCall(prompt, { model: AUDIT_DEFAULT_MODEL });
  const parsed = auditOutputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`audit output failed lenient parse: ${parsed.error.message}`);
  }
  return { findings: parsed.data.findings, model: AUDIT_DEFAULT_MODEL };
}

function fmtSeverity(s: Severity | null): string {
  return s ?? "(not surfaced)";
}

function renderTargetReport(args: { manifest: TargetManifest; outcome: TargetOutcome }): string {
  const lines: string[] = [];
  lines.push(`# Kill-test target: ${args.manifest.name}`);
  lines.push("");
  lines.push(`- Source: ${args.manifest.source.repo} @ \`${args.manifest.source.commit}\``);
  lines.push(`- Reference (known answer): ${args.manifest.source.referenceUrl}`);
  lines.push(`- Entry contracts: ${args.manifest.entryContracts.join(", ")}`);
  lines.push("");
  lines.push("| bug | expected | slice arm | audit arm | counts toward gate |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const p of args.outcome.perBug) {
    const bug: KnownBug | undefined = args.manifest.knownBugs.find((b) => b.id === p.bugId);
    lines.push(
      `| ${p.bugId} | ${bug?.expectedSeverity ?? "?"} | ${fmtSeverity(p.slice.observedSeverity)} | ${fmtSeverity(p.audit.observedSeverity)} | ${args.outcome.countsTowardGate ? "YES" : "no"} |`,
    );
  }
  lines.push("");
  lines.push("## Verdict factors on matching audit findings");
  lines.push("");
  for (const v of args.outcome.perBug.flatMap((p) => p.auditVerdicts)) {
    lines.push(`- **${v.verdict}** — ${v.reason}`);
  }
  if (args.outcome.perBug.every((p) => p.auditVerdicts.length === 0)) {
    lines.push("(none)");
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const manifests = await loadManifests(cli.targetsDir);
  if (manifests.length === 0) {
    console.error(
      `[killtest] no labeled targets under ${cli.targetsDir} — add targets/<name>/manifest.json + contracts first (see solidity-killtest/README.md)`,
    );
    process.exit(1);
  }
  if (manifests.length < 3) {
    console.error(
      `[killtest] NOTE: ${manifests.length}/3 required targets present — the gate cannot pass yet; running anyway to record partial data`,
    );
  }

  await mkdir(RESULTS_DIR, { recursive: true });
  let cumulativeCost = 0;
  const outcomes: TargetOutcome[] = [];
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");

  for (const target of manifests) {
    const manifestRaw = JSON.parse(
      await readFile(join(target.root, "manifest.json"), "utf8"),
    ) as unknown;
    const manifest = targetManifestSchema.parse(manifestRaw);
    const sourcePaths = await listSourceFiles(target.root);
    const files = await readContextFiles(target.root, sourcePaths);
    console.error(
      `[killtest] ${target.name}: ${files.length} .sol file(s); baseline providers=${cli.providers.join(",")} audit-model=${AUDIT_DEFAULT_MODEL} (est. $${(cli.providers.reduce((sum, p) => sum + estimateCallCost(p), 0) + estimateCallCost("anthropic")).toFixed(2)})`,
    );

    const sliceFindings: BaselineFinding[] = [];
    let auditFindings: Awaited<ReturnType<typeof runAuditArm>>["findings"] = [];
    let armErrors: string[] = [];

    try {
      const baselineEstimate = cli.providers.reduce((sum, p) => sum + estimateCallCost(p), 0);
      const abort = shouldAbortBeforeRun(cumulativeCost, baselineEstimate, cli.ceilingUsd);
      if (abort.abort) {
        console.error(`[killtest] cost ceiling: skipping baseline arm (${abort.reason})`);
        armErrors.push("baseline skipped: cost ceiling");
      } else {
        for (const providerName of cli.providers) {
          await runBaselineArm({
            providerName,
            targetRoot: target.root,
            files,
            sliceFindingsSink: sliceFindings,
          });
          cumulativeCost += estimateCallCost(providerName);
        }
      }
    } catch (err) {
      armErrors.push(`baseline arm error: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const abort = shouldAbortBeforeRun(
        cumulativeCost,
        estimateCallCost("anthropic"),
        cli.ceilingUsd,
      );
      if (abort.abort) {
        console.error(`[killtest] cost ceiling: skipping audit arm (${abort.reason})`);
        armErrors.push("audit skipped: cost ceiling");
      } else {
        const result = await runAuditArm({ targetRoot: target.root, manifest, files });
        auditFindings = result.findings;
        cumulativeCost += estimateCallCost("anthropic");
      }
    } catch (err) {
      armErrors.push(`audit arm error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Both arms feed the SAME matcher. Slice findings keep their native shape
    // (they already satisfy the evidence/severity fields); audit findings are
    // the leniently-parsed factor-bearing ones.
    const outcome = evaluateTarget({
      targetName: manifest.name,
      sliceFindings: sliceFindings,
      auditFindings: auditFindings.map((f) => ({ ...f, severity: f.severity as Severity })),
      bugs: manifest.knownBugs,
    });
    outcomes.push(outcome);

    const report = renderTargetReport({ manifest, outcome });
    const reportPath = join(RESULTS_DIR, `${target.name}-${timestamp}.md`);
    await writeFile(reportPath, report, "utf8");
    if (armErrors.length > 0) {
      await writeFile(
        join(RESULTS_DIR, `${target.name}-${timestamp}.errors.txt`),
        armErrors.join("\n"),
        "utf8",
      );
      console.error(`[killtest] ${target.name}: ARM ERRORS recorded in ${reportPath}.errors.txt`);
    }
    console.error(
      `[killtest] ${target.name}: gate-relevant=${outcome.countsTowardGate} (slice=${outcome.sliceArm.caught ? outcome.sliceArm.observedSeverity : "missed"}, audit=${outcome.auditArm.caught ? outcome.auditArm.observedSeverity : "missed"}) → ${relative(ROOT, reportPath)}`,
    );
  }

  const gate: GateDecision = evaluateGate(outcomes);
  const summary = {
    schemaVersion: 1,
    spec: "specs/SOLIDITY_AUDIT_MODE_SPEC.md §2",
    ranAt: new Date().toISOString(),
    estimatedCostUsd: Number(cumulativeCost.toFixed(3)),
    targets: outcomes.map((o) => ({
      name: o.targetName,
      sliceMissedOrUnderRated: o.sliceMissedOrUnderRated,
      auditSurfacedCorrectly: o.auditSurfacedCorrectly,
      countsTowardGate: o.countsTowardGate,
      perBug: o.perBug,
    })),
    gate,
  };
  const summaryPath = join(RESULTS_DIR, `summary-${timestamp}.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  console.error("");
  console.error("=========================================");
  console.error(`§2 GATE: ${gate.pass ? "PASS" : "FAIL"}`);
  console.error(`  passedTargets: ${gate.passedTargets}/${gate.totalTargets}`);
  console.error(`  reason: ${gate.reason}`);
  console.error(`  summary: ${relative(ROOT, summaryPath)}`);
  console.error("=========================================");
  if (gate.pass) {
    console.error("Premise holds — §3 sidecar implementation is authorized.");
  } else {
    console.error("Per spec §2: do NOT build §3. Record this result.");
  }
}

void main().catch((err) => {
  console.error(`[killtest] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  process.exit(1);
});
