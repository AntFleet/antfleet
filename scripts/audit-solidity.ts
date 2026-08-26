/**
 * `pnpm audit-solidity` — whole-contract Solidity finder sidecar CLI.
 * specs/SOLIDITY_SIDECAR_SPEC.md §4
 *
 * A → assembleClosure (bidirectional, budgeted) → B → neutral finder prompt
 * → C → scoreAuditFinding (unchanged reuse). DRY-RUN by default: assembles,
 * renders the prompt, prints closure stats — NO model call, no API key needed.
 * --live performs the single finder call via src/sidecar-solidity/model-client.
 *
 * Sidecar discipline (§0): imports NOTHING from apps/web review-worker/
 * review-pipeline/chunking. Finding-phase only: no verification, no submission.
 */

import { config as loadDotenv } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assembleClosure, fsReadRepoFile, listSolFiles } from "../src/sidecar-solidity/closure.js";
import { auditModelCall } from "../src/sidecar-solidity/model-client.js";
import { runFinder } from "../src/sidecar-solidity/run.js";

loadDotenv({ path: resolve(process.cwd(), ".env.local"), quiet: true });

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

Default is DRY-RUN (no model call). --live requires ANTHROPIC_API_KEY.`);
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
      case "--budget":
        args.budgetBytes = Number.parseInt(take(), 10);
        if (!Number.isFinite(args.budgetBytes) || args.budgetBytes <= 0) {
          usage();
        }
        i += 2;
        break;
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

function fmtBytes(n: number): string {
  return `${(n / 1000).toFixed(1)}k chars`;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const root = resolve(cli.target);
  const programRules = await readFile(resolve(cli.rulesPath), "utf8");

  // A — bidirectional dependency-closure context assembly
  const allPaths = await listSolFiles(root);
  const closure = await assembleClosure({
    entries: cli.entries,
    allPaths,
    readFile: fsReadRepoFile(root),
    budgetBytes: cli.budgetBytes,
  });

  const rolesFor = (p: string): string => closure.roles.get(p) ?? "?";
  console.error("[audit-solidity] closure assembled:");
  for (const block of closure.blocks) {
    console.error(`  [${rolesFor(block.path)}] ${block.path} (${fmtBytes(block.contents.length)})`);
  }
  for (const evicted of closure.evicted) {
    console.error(`  [evicted] ${evicted}`);
  }
  for (const external of closure.externalUnresolved) {
    console.error(`  [unresolved external] ${external}`);
  }
  console.error(
    `  total: ${closure.blocks.length} file(s), ${fmtBytes(closure.bytes)}, truncated=${closure.truncated}${closure.entryOverflow ? " (ENTRY OVERFLOW — entries kept whole)" : ""}`,
  );
  if (closure.entryOverflow) {
    console.warn(
      `[audit-solidity] WARNING: entry set alone exceeds budget (${fmtBytes(closure.bytes)} > ${fmtBytes(cli.budgetBytes)}); entries kept whole per spec.`,
    );
  }

  // B + C — dry-run stops after the rendered prompt; --live executes and scores.
  const result = await runFinder(
    {
      projectName: root.split("/").pop() ?? "target",
      entries: cli.entries,
      files: closure.blocks,
      programRules,
      contextNote: `closure: ${closure.blocks.length} file(s), ${fmtBytes(closure.bytes)}${closure.truncated ? ", TRUNCATED (see report header)" : ""}`,
    },
    cli.live ? (prompt) => auditModelCall(prompt) : undefined,
  );

  if (!cli.live) {
    console.error("[audit-solidity] DRY-RUN: no model call performed. Prompt below.");
    console.error("");
    process.stdout.write(`${result.prompt}\n`);
    if (cli.outPath !== null) {
      await writeFile(cli.outPath, result.prompt, "utf8");
      console.error(`[audit-solidity] prompt written to ${cli.outPath}`);
    }
    return;
  }

  const lines: string[] = [];
  lines.push(`# Solidity finder report — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    `- Closure: ${closure.blocks.length} file(s), ${fmtBytes(closure.bytes)}, truncated=${closure.truncated}`,
  );
  lines.push(`- Entries: ${cli.entries.join(", ")}`);
  if (closure.evicted.length > 0) {
    lines.push(`- Evicted over budget: ${closure.evicted.join(", ")}`);
  }
  if (closure.externalUnresolved.length > 0) {
    lines.push(
      `- Unresolved externals (INCOMPLETE CLOSURE): ${closure.externalUnresolved.join(", ")}`,
    );
  }
  lines.push(
    `- Findings: ${result.findings.length} (${result.pursueCount} PURSUE / ${result.droppedCount} DROP)`,
  );
  lines.push("");
  lines.push("## Scored findings");
  lines.push("");
  for (const s of result.scored) {
    lines.push(`### **${s.verdict}** — ${s.finding.title} [${s.finding.severity}]`);
    lines.push(`- reason: ${s.reason}`);
    lines.push(`- triggerRole: ${s.finding.triggerRole}`);
    lines.push(`- preconditions: ${s.finding.preconditions}`);
    for (const e of s.finding.evidence) {
      lines.push(`- evidence: \`${e.path}:${e.startLine ?? "?"}-${e.endLine ?? "?"}\``);
    }
    lines.push(`- reasoning: ${s.finding.reasoning}`);
    lines.push("");
  }
  const reportJson = JSON.stringify(
    {
      schemaVersion: 1,
      closure: {
        includedFiles: closure.blocks.map((b) => b.path),
        evicted: closure.evicted,
        externalUnresolved: closure.externalUnresolved,
        bytes: closure.bytes,
        truncated: closure.truncated,
      },
      ...result,
    },
    null,
    2,
  );

  const mdReport = lines.join("\n");
  process.stdout.write(mdReport);
  if (cli.outPath !== null) {
    await writeFile(cli.outPath, reportJson, "utf8");
    await writeFile(`${cli.outPath}.md`, mdReport, "utf8");
    console.error(`[audit-solidity] report written to ${cli.outPath}(+.md)`);
  }
}

void main().catch((err) => {
  console.error(
    `[audit-solidity] fatal: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
  );
  process.exit(1);
});
