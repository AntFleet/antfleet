/**
 * §2 KILL-TEST RUNNER — Solidity full-contract audit premise test.
 * specs/SOLIDITY_AUDIT_MODE_SPEC.md — REWORKED per REWORK_PROMPT items 4+5.
 *
 * C2: a target whose baseline or audit arm errored/was cost-skipped is
 * EXCLUDED from the gate — a broken baseline must never manufacture a "miss".
 * The audit arm uses the SAME bidirectional assembleClosure() that ships in the
 * sidecar, so the gate validates what actually ships.
 *
 * SPEND SAFETY (item 5): DRY-RUN by default — without --live this prints the
 * run plan and exits. --ceiling is validated (NaN no longer silently disables
 * the cap) and cost is accumulated PER CALL with a ceiling re-check before each
 * slice, not per target.
 */

import { config as loadDotenv } from "dotenv";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { providerByName } from "../src/provider.js";
import { estimateCallCost, shouldAbortBeforeRun } from "../src/spike/cost.js";
import { buildSpikePrompt, type PromptFile } from "../src/spike/build-prompt.js";
import {
  assembleClosure,
  fsReadRepoFile,
  listSolFiles,
  loadRemappings,
} from "../src/sidecar-solidity/closure.js";
import { auditModelCall } from "../src/sidecar-solidity/model-client.js";
import { buildFinderPrompt } from "../src/sidecar-solidity/prompt.js";
import { lenientParseFindings } from "../src/sidecar-solidity/finding-schema.js";
import {
  evaluateGate,
  evaluateTarget,
  targetManifestSchema,
  validateArmSplit,
  type GateDecision,
  type Severity,
  type TargetOutcome,
  type TargetManifest,
  type ArmRunStatus,
} from "../src/sidecar-solidity/kill-gate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGETS_DIR = resolve(ROOT, "solidity-killtest/targets");
const RESULTS_DIR = resolve(ROOT, "solidity-killtest/results");

loadDotenv({ path: resolve(ROOT, ".env.local"), quiet: true });

type CliArgs = {
  targetsDir: string;
  providers: string[];
  ceilingUsd: number;
  live: boolean;
};

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    targetsDir: DEFAULT_TARGETS_DIR,
    providers: ["anthropic"],
    ceilingUsd: 10,
    live: false,
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
      // Item 5: NaN silently disabled the cap before. Validate hard.
      const parsed = Number.parseFloat(take());
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--ceiling must be a finite number >= 0");
      }
      args.ceilingUsd = parsed;
      i += 2;
      continue;
    }
    if (arg === "--live") {
      args.live = true;
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.error(
        "usage: killtest [--targets-dir DIR] [--providers a,b] [--ceiling USD] [--live]",
      );
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function listSourceFiles(root: string): Promise<string[]> {
  return listSolFiles(root); // symlink-safe walker (item 6)
}

async function loadManifests(targetsDir: string): Promise<{ name: string; root: string }[]> {
  const entries = await readdir(targetsDir, { withFileTypes: true });
  const out: { name: string; root: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(targetsDir, entry.name, "manifest.json"), "utf8");
      out.push({ name: entry.name, root: join(targetsDir, entry.name) });
    } catch {
      // Directory without a manifest is not a target; ignore.
    }
  }
  return out.toSorted((a, b) => (a.name < b.name ? -1 : 1));
}

type BaselineFinding = {
  title: string;
  severity: Severity;
  evidence: { path: string; startLine: number | null; endLine: number | null }[];
};

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const manifests = await loadManifests(cli.targetsDir);
  if (manifests.length === 0) {
    console.error(
      `[killtest] no labeled targets under ${cli.targetsDir} — add targets/<name>/manifest.json first`,
    );
    process.exit(1);
  }

  if (!cli.live) {
    console.error(
      `[killtest] DRY-RUN (default): ${manifests.length} target(s) found, providers=${cli.providers.join(",")}, ceiling=$${cli.ceilingUsd.toFixed(2)}. NO model calls will be made.`,
    );
    for (const t of manifests) {
      try {
        const manifest = targetManifestSchema.parse(
          JSON.parse(await readFile(join(t.root, "manifest.json"), "utf8")),
        );
        const sourcePaths = await listSourceFiles(t.root);
        const remappings = await loadRemappings(t.root);
        const closure = await assembleClosure({
          entries: manifest.entryContracts,
          allPaths: sourcePaths,
          readFile: fsReadRepoFile(t.root),
          remappings,
        });
        const discriminatingFiles = manifest.knownBugs.flatMap(
          (b) => b.discriminatingFiles ?? [b.file],
        );
        const sliceArmFiles = manifest.entryContracts.filter(
          (e) => !discriminatingFiles.some((d) => e.endsWith(d) || d.endsWith(e)),
        );
        const auditArmFiles = closure.blocks.map((b) => b.path);
        const split = validateArmSplit({ discriminatingFiles, sliceArmFiles, auditArmFiles });
        console.error(
          `  would run: ${t.name} (slice over ${sliceArmFiles.length} entry file(s), audit over ${auditArmFiles.length} closure file(s)) — arm split ${split.valid ? "VALID" : `INVALID → would be EXCLUDED: ${split.reason}`}`,
        );
      } catch (err) {
        console.error(
          `  ${t.name}: cannot plan — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    console.error("[killtest] pass --live to execute against real APIs.");
    process.exit(0);
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
    const remappings = await loadRemappings(target.root);

    let sliceFindings: BaselineFinding[] = [];
    let auditFindings: {
      title: string;
      severity: Severity;
      evidence: BaselineFinding["evidence"];
    }[] = [];
    let armErrors: string[] = [];
    let baselineStatus: ArmRunStatus = "errored";
    let auditStatus: ArmRunStatus = "errored";

    // CLOSURE_UPGRADE item 4: SLICE arm = entry files ONLY, minus any
    // discriminating sibling; the deciding file must NOT be visible to the slice.
    // AUDIT arm file list is captured from the shipping closure below.
    const discriminatingFiles = manifest.knownBugs.flatMap(
      (b) => b.discriminatingFiles ?? [b.file],
    );
    const sliceArmFiles = manifest.entryContracts.filter(
      (e) => !discriminatingFiles.some((d) => e.endsWith(d) || d.endsWith(e)),
    );
    let auditArmFiles: string[] = [];

    const checkCeiling = (nextCallEstimate: number): boolean => {
      const decision = shouldAbortBeforeRun(cumulativeCost, nextCallEstimate, cli.ceilingUsd);
      if (decision.abort) {
        armErrors.push(`cost ceiling hit before call (${decision.reason})`);
        return false;
      }
      return true;
    };

    // ARM 1 — baseline (current finding phase): slices via production prompt.
    try {
      const provider = providerByName(cli.providers[0] ?? "anthropic");
      await provider.check(target.root);
      // Slice arm sees ONLY the entry files (minus the discriminating sibling),
      // packed into ≤150KB review units — the single-file finding phase.
      const read = fsReadRepoFile(target.root);
      const sliceFiles: PromptFile[] = [];
      for (const path of sliceArmFiles) {
        sliceFiles.push({ path, contents: await read(path) });
      }
      const sliceInputs: PromptFile[][] = packIntoSlices(sliceFiles);
      sliceFindings = [];
      let ranAnySlice = false;
      for (const slice of sliceInputs) {
        if (!checkCeiling(estimateCallCost(provider.name))) break;
        const prompt = buildSpikePrompt({
          projectName: "killtest-baseline",
          projectRoot: target.root,
          featureId: `slice-${ranAnySlice ? sliceFindings.length : 0}`,
          featureTitle: `Slice (${slice.length} file(s))`,
          files: slice,
        });
        const output = await provider.review(target.root, prompt, null);
        cumulativeCost += estimateCallCost(provider.name);
        ranAnySlice = true;
        for (const finding of output.findings) {
          sliceFindings.push({
            title: finding.title,
            severity: finding.severity,
            evidence: finding.evidence.map((e) => ({
              path: e.path,
              startLine: e.startLine,
              endLine: e.endLine,
            })),
          });
        }
      }
      baselineStatus = ranAnySlice ? "ran" : "skipped";
    } catch (err) {
      armErrors.push(`baseline arm error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ARM 2 — new mode via the SHIPPING bidirectional assembler (item 4).
    try {
      if (checkCeiling(estimateCallCost("anthropic"))) {
        const closure = await assembleClosure({
          entries: manifest.entryContracts,
          allPaths: sourcePaths,
          readFile: fsReadRepoFile(target.root),
          remappings,
        });
        auditArmFiles = closure.blocks.map((b) => b.path);
        const contextNote =
          closure.externalUnresolved.length > 0
            ? `closure of available files; NOT available: ${closure.externalUnresolved.join(", ")}`
            : undefined;
        const prompt = buildFinderPrompt({
          projectName: manifest.name,
          entries: manifest.entryContracts,
          files: closure.blocks,
          programRules: manifest.programRules,
          contextNote,
        });
        const handled = await auditModelCall(prompt);
        cumulativeCost += estimateCallCost("anthropic");
        if (handled.truncated) {
          armErrors.push("audit output truncated at max_tokens (incomplete)");
        }
        const raw = handled.payload as Record<string, unknown> | null;
        const rawList =
          raw !== null && typeof raw === "object" && Array.isArray(raw["findings"])
            ? (raw["findings"] as unknown[])
            : [];
        const { findings } = lenientParseFindings(rawList);
        auditFindings = findings.map((f) => ({
          title: f.title,
          severity: f.severity,
          evidence: f.evidence.map((e) => ({
            path: e.path,
            startLine: e.startLine,
            endLine: e.endLine,
          })),
        }));
        auditStatus = "ran";
      }
    } catch (err) {
      armErrors.push(`audit arm error: ${err instanceof Error ? err.message : String(err)}`);
    }

    const outcome = evaluateTarget({
      targetName: manifest.name,
      baselineStatus,
      auditStatus,
      sliceFindings,
      auditFindings,
      bugs: manifest.knownBugs,
      sliceArmFiles,
      auditArmFiles,
    });
    outcomes.push(outcome);

    const reportPath = join(RESULTS_DIR, `${target.name}-${timestamp}.md`);
    await writeFile(reportPath, renderTargetReport(manifest, outcome), "utf8");
    if (armErrors.length > 0) {
      await writeFile(
        join(RESULTS_DIR, `${target.name}-${timestamp}.errors.txt`),
        armErrors.join("\n"),
        "utf8",
      );
    }
    console.error(
      `[killtest] ${target.name}: baseline=${baselineStatus} audit=${auditStatus} gate-relevant=${outcome.countsTowardGate}${outcome.excludedFromGate ? ` [EXCLUDED: ${outcome.exclusionReason}]` : ""} → ${relative(ROOT, reportPath)}`,
    );
  }

  const gate: GateDecision = evaluateGate(outcomes);
  const summary = {
    schemaVersion: 2,
    spec: "specs/SOLIDITY_AUDIT_MODE_SPEC.md §2",
    ranAt: new Date().toISOString(),
    estimatedCostUsd: Number(cumulativeCost.toFixed(3)),
    targets: outcomes.map((o) => ({
      name: o.targetName,
      baselineStatus: o.baselineRan ? "ran" : "did-not-run",
      auditStatus: o.auditRan ? "ran" : "did-not-run",
      armsSplitValid: o.armsSplitValid,
      excludedFromGate: o.excludedFromGate,
      exclusionReason: o.exclusionReason,
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
  console.error(`  eligible targets (both arms ran): ${gate.eligibleTargets}/${gate.totalTargets}`);
  console.error(`  passedTargets: ${gate.passedTargets}/${gate.eligibleTargets}`);
  console.error(`  reason: ${gate.reason}`);
  console.error(`  summary: ${relative(ROOT, summaryPath)}`);
  console.error("=========================================");
}

/** ≤150KB slice packing mirroring chunk-repo-for-bench's PR chunks. */
function packIntoSlices(files: readonly { path: string; contents: string }[]): PromptFile[][] {
  const MAX = 150_000;
  const sorted = [...files].toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const slices: PromptFile[][] = [];
  let current: PromptFile[] = [];
  let currentBytes = 0;
  for (const file of sorted) {
    const size = Buffer.byteLength(file.contents, "utf8");
    if (size > MAX) {
      if (current.length > 0) {
        slices.push(current);
        current = [];
        currentBytes = 0;
      }
      slices.push([file]);
      continue;
    }
    if (currentBytes + size > MAX) {
      slices.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += size;
  }
  if (current.length > 0) {
    slices.push(current);
  }
  return slices.filter((s) => s.length > 0);
}

function renderTargetReport(manifest: TargetManifest, outcome: TargetOutcome): string {
  const lines: string[] = [];
  lines.push(`# Kill-test target: ${manifest.name}`);
  lines.push("");
  lines.push(`- Source: ${manifest.source.repo} @ \`${manifest.source.commit}\``);
  lines.push(`- Reference (known answer): ${manifest.source.referenceUrl}`);
  lines.push(
    `- Arms: baseline=${outcome.baselineRan ? "ran" : "DID-NOT-RUN"} audit=${outcome.auditRan ? "ran" : "DID-NOT-RUN"} arm-split=${outcome.armsSplitValid ? "valid" : "INVALID"}`,
  );
  lines.push(
    `- Gate: ${outcome.excludedFromGate ? `EXCLUDED — ${outcome.exclusionReason}` : outcome.countsTowardGate ? "COUNTS" : "no delta"}`,
  );
  lines.push("");
  lines.push("| bug | expected | slice arm | audit arm |");
  lines.push("| --- | --- | --- | --- |");
  for (const p of outcome.perBug) {
    const known = manifest.knownBugs.find((b) => b.id === p.bugId);
    lines.push(
      `| ${p.bugId} | ${known?.expectedSeverity ?? "?"} | ${p.slice.observedSeverity ?? "(not surfaced)"} | ${p.audit.observedSeverity ?? "(not surfaced)"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

void main().catch((err) => {
  console.error(`[killtest] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  process.exit(1);
});
