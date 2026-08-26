/**
 * `pnpm audit-solidity` — whole-contract Solidity finder sidecar CLI.
 * specs/SOLIDITY_SIDECAR_SPEC.md §4 — POST-AUDIT REWORK.
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
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assembleClosure,
  fsReadRepoFile,
  listSolFiles,
  loadRemappings,
} from "../src/sidecar-solidity/closure.js";
import { auditModelCall } from "../src/sidecar-solidity/model-client.js";
import {
  runFinder,
  type ConfirmCallback,
  type RefuteCallback,
} from "../src/sidecar-solidity/run.js";
import { refuteFinding, refuterTransport } from "../src/sidecar-solidity/refuter.js";
import { buildFocusedConfirmPrompt } from "../src/sidecar-solidity/prompt.js";

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

Default is DRY-RUN (no model call, findings never promoted).
--live requires ANTHROPIC_API_KEY (or SIDECAR_* overrides) and runs BOTH the
finder and the independent adversarial refuter.`);
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

function fmtBytes(n: number): string {
  return `${(n / 1000).toFixed(1)}k chars`;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const root = resolve(cli.target);
  const programRules = await readFile(resolve(cli.rulesPath), "utf8");

  // A — bidirectional dependency-closure assembly (remappings loaded by caller)
  const allPaths = await listSolFiles(root);
  const remappings = await loadRemappings(root);
  const closure = await assembleClosure({
    entries: cli.entries,
    allPaths,
    readFile: fsReadRepoFile(root),
    budgetBytes: cli.budgetBytes,
    remappings,
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
  if (closure.externalUnresolved.length > 0) {
    console.warn(
      `[audit-solidity] WARNING: incomplete closure — ${closure.externalUnresolved.length} unresolved external(s); the prompt states this honestly.`,
    );
  }

  // B + C — dry-run renders only; --live runs finder AND refuter.
  // SIDECAR_FINDER_MODEL (optional) routes the discovery calls (stage A + the
  // focused stage-B confirm) to a stronger model — e.g. opus for finding while a
  // cheaper model (SIDECAR_MODEL) runs the adversarial refuter.
  const finderModel = process.env["SIDECAR_FINDER_MODEL"];
  const finderOpts = finderModel === undefined ? undefined : { model: finderModel };
  if (cli.live && finderModel !== undefined) {
    console.error(
      `[audit-solidity] finder calls (stage A + confirm) routed to model: ${finderModel}`,
    );
  }
  const finderTransport = cli.live
    ? async (prompt: string) => {
        const { payload, truncated } = await auditModelCall(prompt, finderOpts);
        return { payload, truncated };
      }
    : undefined;
  const refuterCallback: RefuteCallback | undefined = cli.live
    ? async ({ finding }) => {
        const r = await refuteFinding(
          {
            finding,
            files: closure.blocks,
            programRules,
            priorFindings: [], // operator-supplied corpus hook; empty unless provided
          },
          refuterTransport, // WITHOUT this, refuteFinding returns the dry-run KILLED stub
        );
        return { verdict: r.verdict, reason: r.reason } as const;
      }
    : undefined;
  // Stage-B focused confirm (CLOSURE_UPGRADE item 2.1): wiring this turns the
  // finder two-stage — stage A sees only entries, stage B re-runs each candidate
  // over exactly its named siblings. Without it runFinder falls back to the
  // single whole-closure dump (which gets skimmed — the Monetrix lesson).
  const confirmCallback: ConfirmCallback | undefined = cli.live
    ? async ({ finding, focusedFiles, programRules: rules }) => {
        const prompt = buildFocusedConfirmPrompt({
          finding: {
            title: finding.title,
            severity: finding.severity,
            confidence: finding.confidence,
            reasoning: finding.reasoning,
            evidence: finding.evidence,
            triggerRole: finding.triggerRole,
            preconditions: finding.preconditions,
          },
          files: focusedFiles,
          programRules: rules,
        });
        const { payload, truncated } = await auditModelCall(prompt, finderOpts);
        return { payload, truncated };
      }
    : undefined;
  const result = await runFinder(
    {
      projectName: root.split("/").pop() ?? "target",
      entries: cli.entries,
      files: closure.blocks,
      programRules,
      closureStats: {
        truncated: closure.truncated,
        evicted: closure.evicted,
        externalUnresolved: closure.externalUnresolved,
      },
    },
    finderTransport,
    refuterCallback,
    confirmCallback,
  );

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

  const lines: string[] = [];
  lines.push(`# Solidity finder report — ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    `- Closure: ${closure.blocks.length} file(s), ${fmtBytes(closure.bytes)}, truncated=${closure.truncated}${result.truncated ? "; MODEL OUTPUT TRUNCATED (INCOMPLETE)" : ""}`,
  );
  lines.push(`- Entries: ${cli.entries.join(", ")}`);
  if (closure.evicted.length > 0) {
    lines.push(`- Evicted over budget (NOT audited): ${closure.evicted.join(", ")}`);
  }
  if (closure.externalUnresolved.length > 0) {
    lines.push(
      `- Unresolved externals (INCOMPLETE CLOSURE): ${closure.externalUnresolved.join(", ")}`,
    );
  }
  lines.push(
    `- Findings: ${result.findings.length} (${result.pursueCount} PURSUE / ${result.droppedCount} DROP)`,
  );
  if (result.rejectedRaw.length > 0) {
    lines.push(`- Unparseable findings (raw preserved below): ${result.rejectedRaw.length}`);
  }
  lines.push("");
  lines.push("## Scored findings");
  lines.push("");
  for (const s of result.scored) {
    lines.push(`### **${s.verdict}** — ${s.finding.title} [${s.finding.severity}]`);
    lines.push(`- reason: ${s.reason}`);
    if (s.advisory !== "no adverse advisory factors") {
      lines.push(`- advisory (model self-report, NOT a gate): ${s.advisory}`);
    }
    lines.push(`- triggerRole: ${s.finding.triggerRole}`);
    lines.push(`- preconditions: ${s.finding.preconditions}`);
    for (const e of s.finding.evidence) {
      lines.push(`- evidence: \`${e.path}:${e.startLine ?? "?"}-${e.endLine ?? "?"}\``);
    }
    lines.push(`- reasoning: ${s.finding.reasoning}`);
    lines.push("");
  }
  if (result.rejectedRaw.length > 0) {
    lines.push("## Unparseable raw findings (preserved for inspection)");
    for (const r of result.rejectedRaw) {
      lines.push(`- index ${r.index}: ${JSON.stringify(r.raw)}`);
    }
    lines.push("");
  }
  const mdReport = lines.join("\n");
  process.stdout.write(mdReport);
  if (cli.outPath !== null) {
    const reportJson = JSON.stringify(
      {
        schemaVersion: 2,
        closure: {
          includedFiles: closure.blocks.map((b) => b.path),
          evicted: closure.evicted,
          externalUnresolved: closure.externalUnresolved,
          bytes: closure.bytes,
          truncated: closure.truncated,
        },
        modelTruncated: result.truncated,
        ...result,
      },
      null,
      2,
    );
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
