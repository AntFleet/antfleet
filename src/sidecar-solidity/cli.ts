#!/usr/bin/env node
/**
 * `pnpm audit-solidity` / `antfleet-audit` — whole-contract Solidity finder
 * sidecar CLI. specs/SOLIDITY_SIDECAR_SPEC.md §4 — POST-AUDIT REWORK.
 *
 * A → bidirectional dependency-closure assembly → B → neutral finder prompt →
 * C → mechanical citation-grounding + independent adversarial refuter pass.
 * PURSUE requires BOTH grounding and refuter survival; model booleans are
 * advisory metadata only.
 *
 * DRY-RUN is the default: assembles, renders the prompt, grounds nothing to
 * promote — NO model call, no API key. --live runs finder + refuter through the
 * shared transport (model-client.ts). Finding-phase only: no verification, no
 * submission.
 */

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fsReadRepoFile, listSolFiles, loadRemappings } from "./closure.js";
import {
  auditEntry,
  buildPursueMarkdown,
  buildSweepSummary,
  parseEntriesFromFile,
  renderDryRunEntryReport,
  renderLiveReport,
  resolveEntriesGlob,
  runSweepAudits,
  sanitizeEntryPath,
  type EntryPursueFindings,
} from "./sweep.js";

// Load config from any working directory: a global config (installed via the
// `antfleet-audit` bin) first, then a repo-local override — neither overrides
// vars already set in the environment.
const globalEnvPath = resolve(homedir(), ".config/antfleet-audit/.env");
if (existsSync(globalEnvPath)) {
  loadDotenv({ path: globalEnvPath, quiet: true });
}
const localEnvPath = resolve(process.cwd(), ".env.local");
if (existsSync(localEnvPath)) {
  loadDotenv({ path: localEnvPath, quiet: true });
}

type CliArgs = {
  target: string;
  entries: string[];
  rulesPath: string;
  budgetBytes: number;
  outPath: string | null;
  live: boolean;
};

function usage(): never {
  console.error(`usage:
  pnpm audit-solidity --target <dir> --entry <repo-relative .sol path>
                      [--entry ...] --rules <file.md> [--budget <bytes>]
                      [--out <report.json>] [--live]

Default is DRY-RUN (no model call, findings never promoted).
--live runs the finder (gpt-5.6-sol) + the independent adversarial refuter
(gpt-5.5) via OpenRouter; set OPENROUTER_API_KEY (or SIDECAR_API_KEY). Override
models with SIDECAR_FINDER_MODEL / SIDECAR_REFUTER_MODEL.`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    target: "",
    entries: [],
    rulesPath: "",
    budgetBytes: 400_000,
    outPath: null,
    live: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? "";
    const take = (): string => {
      const next = argv[i + 1];
      if (next === undefined) {
        usage();
      }
      return next ?? "";
    };
    switch (arg) {
      case "--target":
        args.target = take();
        i += 2;
        break;
      case "--entry":
        args.entries.push(take());
        i += 2;
        break;
      case "--rules":
        args.rulesPath = take();
        i += 2;
        break;
      case "--budget": {
        const raw = take();
        const parsed = Number.parseFloat(raw);
        // Item 5: NaN silently disabled the cap before.
        if (!Number.isFinite(parsed) || parsed < 0) {
          console.error(`invalid --budget value: ${raw}`);
          usage();
        }
        args.budgetBytes = parsed;
        i += 2;
        break;
      }
      case "--out":
        args.outPath = take();
        i += 2;
        break;
      case "--live":
        args.live = true;
        i += 1;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        console.error(`unknown argument: ${arg}`);
        usage();
    }
  }
  if (args.target === "" || args.entries.length === 0 || args.rulesPath === "") {
    usage();
  }
  return args;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const root = resolve(cli.target);
  const programRules = await readFile(resolve(cli.rulesPath), "utf8");

  // A — bidirectional dependency-closure assembly (remappings loaded by caller)
  const allPaths = await listSolFiles(root);
  const remappings = await loadRemappings(root);

  // B + C — dry-run renders only; --live runs finder AND refuter. Model combo
  // (model-client defaults): finder/stage-A/stage-B = gpt-5.6-sol, refuter =
  // gpt-5.5. SIDECAR_FINDER_MODEL (optional) overrides just the discovery
  // calls (stage A + focused stage-B confirm).
  const finderModel = process.env["SIDECAR_FINDER_MODEL"];
  const { closure, result } = await auditEntry({
    root,
    entries: cli.entries,
    programRules,
    budgetBytes: cli.budgetBytes,
    allPaths,
    remappings,
    live: cli.live,
    finderModel,
  });

  if (!cli.live) {
    console.error("[audit-solidity] DRY-RUN: no model calls performed. Prompt below.");
    console.error("");
    process.stdout.write(`${result.prompt}\n`);
    if (cli.outPath !== null) {
      await writeFile(cli.outPath, result.prompt, "utf8");
      console.error(`[audit-solidity] prompt written to ${cli.outPath}`);
    }
    return;
  }

  if (result.truncated) {
    console.error(
      "[audit-solidity] WARNING: model output was TRUNCATED (stop_reason=max_tokens). This run is INCOMPLETE.",
    );
  }
  if (result.rejectedRaw.length > 0) {
    console.error(
      `[audit-solidity] NOTE: ${result.rejectedRaw.length} finding(s) failed lenient parse — raw preserved in report.`,
    );
  }

  const { json: reportJson, md: mdReport } = renderLiveReport({
    entries: cli.entries,
    closure,
    result,
  });
  process.stdout.write(mdReport);
  if (cli.outPath !== null) {
    await writeFile(cli.outPath, JSON.stringify(reportJson, null, 2), "utf8");
    await writeFile(`${cli.outPath}.md`, mdReport, "utf8");
    console.error(`[audit-solidity] report written to ${cli.outPath}(+.md)`);
  }
}

// --- sweep subcommand --------------------------------------------------------

type SweepCliArgs = {
  target: string;
  entries: string[];
  rulesPath: string;
  outDir: string;
  concurrency: number;
  budgetBytes: number;
  live: boolean;
};

function sweepUsage(): never {
  console.error(`usage:
  antfleet-audit sweep --target <dir> [--entry <repo-rel .sol path> ...]
                        [--entries-from <file>] [--entries-glob <glob>]
                        --rules <file.md> --out <dir>
                        [--concurrency <N>] [--budget <bytes>] [--live]

Audits MANY entry contracts over one target repo in one command. Combine
--entry / --entries-from / --entries-glob freely; at least one is required.
Default is DRY-RUN (no model calls). --concurrency defaults to 2.`);
  process.exit(2);
}

function parseBudgetArg(raw: string, usageFn: () => never): number {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`invalid --budget value: ${raw}`);
    usageFn();
  }
  return parsed;
}

async function parseSweepArgs(argv: readonly string[]): Promise<SweepCliArgs> {
  const args = {
    target: "",
    entries: [] as string[],
    entriesFrom: [] as string[],
    entriesGlob: [] as string[],
    rulesPath: "",
    outDir: "",
    concurrency: 2,
    budgetBytes: 400_000,
    live: false,
  };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? "";
    const take = (): string => {
      const next = argv[i + 1];
      if (next === undefined) {
        sweepUsage();
      }
      return next ?? "";
    };
    switch (arg) {
      case "--target":
        args.target = take();
        i += 2;
        break;
      case "--entry":
        args.entries.push(take());
        i += 2;
        break;
      case "--entries-from":
        args.entriesFrom.push(take());
        i += 2;
        break;
      case "--entries-glob":
        args.entriesGlob.push(take());
        i += 2;
        break;
      case "--rules":
        args.rulesPath = take();
        i += 2;
        break;
      case "--out":
        args.outDir = take();
        i += 2;
        break;
      case "--concurrency": {
        const raw = take();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
          console.error(`invalid --concurrency value: ${raw}`);
          sweepUsage();
        }
        args.concurrency = parsed;
        i += 2;
        break;
      }
      case "--budget":
        args.budgetBytes = parseBudgetArg(take(), sweepUsage);
        i += 2;
        break;
      case "--live":
        args.live = true;
        i += 1;
        break;
      case "--help":
      case "-h":
        sweepUsage();
        break;
      default:
        console.error(`unknown argument: ${arg}`);
        sweepUsage();
    }
  }
  if (args.target === "" || args.rulesPath === "" || args.outDir === "") {
    sweepUsage();
  }

  const root = resolve(args.target);
  const allPaths = await listSolFiles(root);
  const readFileRel = fsReadRepoFile(root);

  const entries = new Set<string>(args.entries);
  for (const file of args.entriesFrom) {
    const text = await readFile(resolve(file), "utf8");
    for (const e of parseEntriesFromFile(text)) {
      entries.add(e);
    }
  }
  for (const glob of args.entriesGlob) {
    const matched = await resolveEntriesGlob({ glob, allPaths, readFile: readFileRel });
    for (const e of matched) {
      entries.add(e);
    }
  }
  if (entries.size === 0) {
    console.error("sweep: no entries resolved from --entry / --entries-from / --entries-glob");
    sweepUsage();
  }

  return {
    target: args.target,
    entries: [...entries],
    rulesPath: args.rulesPath,
    outDir: args.outDir,
    concurrency: args.concurrency,
    budgetBytes: args.budgetBytes,
    live: args.live,
  };
}

async function runSweepCli(argv: readonly string[]): Promise<void> {
  const cli = await parseSweepArgs(argv);
  const root = resolve(cli.target);
  const programRules = await readFile(resolve(cli.rulesPath), "utf8");
  const allPaths = await listSolFiles(root);
  const remappings = await loadRemappings(root);

  console.error(
    `[audit-sweep] ${cli.entries.length} entry(ies), concurrency=${cli.concurrency}, live=${cli.live}`,
  );

  const pursueByEntry: EntryPursueFindings[] = [];
  const runOutcomes = await runSweepAudits({
    entries: cli.entries,
    concurrency: cli.concurrency,
    auditFn: async (entry) => {
      const { closure, result } = await auditEntry({
        root,
        entries: [entry],
        programRules,
        budgetBytes: cli.budgetBytes,
        allPaths,
        remappings,
        live: cli.live,
        finderModel: process.env["SIDECAR_FINDER_MODEL"],
        log: (line) => console.error(`[${entry}] ${line}`),
      });
      return { entries: [entry], closure, result };
    },
  });

  for (const { outcome, closure, result } of runOutcomes) {
    const entryDir = join(cli.outDir, sanitizeEntryPath(outcome.entry));
    await mkdir(entryDir, { recursive: true });
    if (closure !== null && result !== null) {
      const { json, md } = cli.live
        ? renderLiveReport({ entries: [outcome.entry], closure, result })
        : renderDryRunEntryReport({ entries: [outcome.entry], closure, result });
      await writeFile(join(entryDir, "report.json"), JSON.stringify(json, null, 2), "utf8");
      await writeFile(join(entryDir, "report.md"), md, "utf8");
      if (cli.live) {
        pursueByEntry.push({ entry: outcome.entry, scored: result.scored });
      }
    } else {
      const errorMd = `# Solidity finder report — ERROR\n\n- Entry: ${outcome.entry}\n- Error: ${outcome.error ?? "unknown error"}\n`;
      await writeFile(join(entryDir, "report.json"), JSON.stringify(outcome, null, 2), "utf8");
      await writeFile(join(entryDir, "report.md"), errorMd, "utf8");
    }
  }

  const summary = buildSweepSummary({
    ranAt: new Date().toISOString(),
    live: cli.live,
    target: cli.target,
    concurrency: cli.concurrency,
    outcomes: runOutcomes.map((o) => o.outcome),
  });
  await mkdir(cli.outDir, { recursive: true });
  await writeFile(join(cli.outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  await writeFile(join(cli.outDir, "PURSUE.md"), buildPursueMarkdown(pursueByEntry), "utf8");

  console.error("");
  console.error(
    `[audit-sweep] done: ${summary.totals.entries} entr${summary.totals.entries === 1 ? "y" : "ies"} run, ` +
      `${summary.totals.pursue} PURSUE, ${summary.totals.drop} DROP, ${summary.totals.errors} error(s)`,
  );
  console.error(`[audit-sweep] output: ${resolve(cli.outDir)}`);
}

async function dispatch(): Promise<void> {
  if (process.argv[2] === "sweep") {
    await runSweepCli(process.argv.slice(3));
    return;
  }
  await main();
}

void dispatch().catch((err) => {
  console.error(
    `[audit-solidity] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
  );
  process.exit(1);
});
