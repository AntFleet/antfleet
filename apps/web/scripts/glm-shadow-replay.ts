/**
 * GLM 5.2 shadow-replay dogfood CLI (decision memo 2026-07-21).
 *
 * Replays stored Opus/GPT-5 disagreement events through the production
 * adjudication path (runAdjudication → GLM 5.2), several runs per event per
 * variant, into the shadow_judge_runs side table. The production flags and
 * finding_status are NEVER touched. Zero new Opus/GPT-5 spend — candidates
 * come from stored JSONB; only GLM judge calls are made, and only with
 * --apply.
 *
 * Usage (from apps/web; export prod DATABASE_URL first — see
 * .omc/runbooks/x_post_queue_runbook.md for the env pattern; ZHIPU_API_KEY
 * required for `run --apply`):
 *   pnpm exec tsx scripts/glm-shadow-replay.ts sample [--all-severities] [--limit N]
 *   pnpm exec tsx scripts/glm-shadow-replay.ts run [--runs 3] [--limit 40]
 *        [--variants full,blinded] [--all-severities] [--apply]
 *   pnpm exec tsx scripts/glm-shadow-replay.ts label <finding-key> <real|not_real>
 *        [--notes "..."] [--apply]
 *   pnpm exec tsx scripts/glm-shadow-replay.ts report
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";
import {
  computeShadowReport,
  renderShadowReportMarkdown,
  runShadowReplay,
  sampleShadowCandidates,
  SHADOW_VARIANTS,
  type ReviewRowForSampling,
  type ShadowCandidate,
  type ShadowVariant,
  type StoredLabel,
  type StoredRun,
} from "../lib/shadow-judge-replay";

type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

const DEFAULT_RUNS = 3;
const DEFAULT_LIMIT = 40;

type CliArgs = {
  command: "sample" | "run" | "label" | "report";
  apply: boolean;
  allSeverities: boolean;
  runs: number;
  limit: number;
  variants: ShadowVariant[];
  findingKey: string;
  labelValue: string;
  notes: string | null;
};

function parseArgs(argv: string[]): CliArgs {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const command = positional[0];
  if (command !== "sample" && command !== "run" && command !== "label" && command !== "report") {
    throw new Error("usage: glm-shadow-replay.ts <sample|run|label|report> [options]");
  }
  const flagValue = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    return value;
  };
  const variantsRaw = flagValue("variants") ?? SHADOW_VARIANTS.join(",");
  const variants = variantsRaw.split(",").map((v) => v.trim()) as ShadowVariant[];
  for (const v of variants) {
    if (!(SHADOW_VARIANTS as readonly string[]).includes(v)) {
      throw new Error(`unknown variant '${v}' — valid: ${SHADOW_VARIANTS.join(", ")}`);
    }
  }
  if (command === "label" && (positional[1] === undefined || positional[2] === undefined)) {
    throw new Error("usage: glm-shadow-replay.ts label <finding-key> <real|not_real>");
  }
  const labelValue = positional[2] ?? "";
  if (command === "label" && labelValue !== "real" && labelValue !== "not_real") {
    throw new Error("label must be 'real' or 'not_real'");
  }
  return {
    command,
    apply: argv.includes("--apply"),
    allSeverities: argv.includes("--all-severities"),
    runs: Number(flagValue("runs") ?? DEFAULT_RUNS),
    limit: Number(flagValue("limit") ?? DEFAULT_LIMIT),
    variants,
    findingKey: positional[1] ?? "",
    labelValue,
    notes: flagValue("notes") ?? null,
  };
}

async function loadReviewRows(db: Queryable): Promise<ReviewRowForSampling[]> {
  // Newest first: recent reviews carry the persisted single-model tier (the
  // authoritative candidate source); older ones fall back to mining.
  const result = await db.query<{
    review_id: string;
    agreement_decision: unknown;
    provider_responses: unknown;
  }>(
    `SELECT review_id, agreement_decision, provider_responses
     FROM reviews
     ORDER BY created_at DESC
     LIMIT 500`,
  );
  return result.rows.map((r) => ({
    reviewId: r.review_id,
    agreementDecision: r.agreement_decision,
    providerResponses: r.provider_responses,
  }));
}

function printCandidates(candidates: ShadowCandidate[], log: Pick<Console, "log">): void {
  const byOrigin = { single_model_tier: 0, mined: 0 };
  for (const c of candidates) byOrigin[c.origin]++;
  log.log(
    `${candidates.length} candidate disagreement events ` +
      `(${byOrigin.single_model_tier} from persisted shadow tier, ${byOrigin.mined} mined)`,
  );
  for (const c of candidates) {
    log.log(
      `— ${c.findingKey}  [${c.flaggingProvider}] [${c.finding.severity}] ${c.finding.title.slice(0, 80)}`,
    );
  }
}

export async function runCli(
  argv: string[],
  db: Queryable,
  log: Pick<Console, "log"> = console,
): Promise<void> {
  const args = parseArgs(argv);

  if (args.command === "sample") {
    const rows = await loadReviewRows(db);
    const candidates = sampleShadowCandidates(rows, {
      allSeverities: args.allSeverities,
      limit: args.limit,
    });
    printCandidates(candidates, log);
    return;
  }

  if (args.command === "run") {
    const rows = await loadReviewRows(db);
    const candidates = sampleShadowCandidates(rows, {
      allSeverities: args.allSeverities,
      limit: args.limit,
    });
    const totalCalls = candidates.length * args.variants.length * args.runs;
    log.log(
      `plan: ${candidates.length} events × ${args.variants.length} variants × ${args.runs} runs ` +
        `= ${totalCalls} GLM calls (existing cells are skipped)`,
    );
    if (!args.apply) {
      printCandidates(candidates, log);
      log.log("dry-run: pass --apply to execute the GLM calls.");
      return;
    }
    if (candidates.length < 30) {
      log.log(
        `warning: only ${candidates.length} candidates (<30 decision-memo minimum) — ` +
          `consider --all-severities or waiting for more reviews.`,
      );
    }
    const summary = await runShadowReplay({
      candidates,
      runsPerVariant: args.runs,
      variants: args.variants,
      io: {
        hasRun: async (findingKey, variant, runIndex) => {
          const existing = await db.query(
            `SELECT 1 FROM shadow_judge_runs
             WHERE finding_key = $1 AND variant = $2 AND run_index = $3`,
            [findingKey, variant, runIndex],
          );
          return existing.rows.length > 0;
        },
        insertRun: async (row) => {
          await db.query(
            `INSERT INTO shadow_judge_runs
             (review_id, finding_key, flagging_provider, variant, run_index, verdict,
              corroborated, reason, judge_model, harness_version, finding_snapshot,
              excerpt_present, ms, error)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (finding_key, variant, run_index) DO NOTHING`,
            [
              row.reviewId,
              row.findingKey,
              row.flaggingProvider,
              row.variant,
              row.runIndex,
              row.verdict,
              row.corroborated,
              row.reason,
              row.judgeModel,
              row.harnessVersion,
              JSON.stringify(row.findingSnapshot),
              row.excerptPresent,
              row.ms,
              row.error,
            ],
          );
        },
        log: (message) => log.log(message),
      },
    });
    log.log(
      `done: ${summary.inserted} inserted, ${summary.skippedExisting} skipped (existing), ` +
        `${summary.errored} errored (fail-open uncertain), ${summary.attempted} attempted`,
    );
    return;
  }

  if (args.command === "label") {
    if (!args.apply) {
      log.log(`dry-run: would label ${args.findingKey} as ${args.labelValue}.`);
      return;
    }
    await db.query(
      `INSERT INTO shadow_judge_labels (finding_key, label, notes)
       VALUES ($1, $2, $3)
       ON CONFLICT (finding_key) DO UPDATE SET label = $2, notes = $3, labeled_at = now()`,
      [args.findingKey, args.labelValue, args.notes],
    );
    log.log(`labeled: ${args.findingKey} = ${args.labelValue}`);
    return;
  }

  // report
  const runsResult = await db.query<StoredRun & Record<string, unknown>>(
    `SELECT finding_key AS "findingKey", variant, run_index AS "runIndex",
            verdict, corroborated, error
     FROM shadow_judge_runs`,
  );
  const labelsResult = await db.query<StoredLabel & Record<string, unknown>>(
    `SELECT finding_key AS "findingKey", label FROM shadow_judge_labels`,
  );
  const reports = computeShadowReport(runsResult.rows, labelsResult.rows);
  if (reports.length === 0) {
    log.log("no shadow runs recorded yet — run `run --apply` first.");
    return;
  }
  const markdown = renderShadowReportMarkdown(reports, new Date().toISOString());
  log.log(markdown);
  const outDir = path.join(process.cwd(), "..", "..", ".omc", "artifacts", "glm-shadow");
  const outPath = path.join(outDir, `report-${new Date().toISOString().slice(0, 10)}.md`);
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, markdown, "utf8");
  log.log(`written: ${outPath}`);
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set; export the prod URL first");
  }
  return databaseUrl;
}

function isDirectCliInvocation(): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;
}

if (isDirectCliInvocation()) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  loadDotenv({ path: ".env.local", quiet: true });
  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = requireDatabaseUrl();
  const host = databaseUrl.match(/@([^/]+)/)?.[1] ?? "(unknown)";
  // eslint-disable-next-line no-console
  console.log(`target host: ${host}`);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runCli(process.argv.slice(2), pool);
  } finally {
    await pool.end();
  }
}
