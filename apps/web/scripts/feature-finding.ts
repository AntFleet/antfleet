/**
 * Manual operator override for the receipt of the week. Upserts a
 * weekly_features row for the current ISO week (Monday 00:00 UTC) pointing
 * at the given finding_id, with curated_by = operator handle.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/feature-finding.ts <findingId> "<rationale>"
 *   pnpm exec tsx scripts/feature-finding.ts <findingId> "<rationale>" --apply
 *
 * OPERATOR_HANDLE env var controls the curated_by value (defaults to
 * "operator"). Replaces any auto-curated row for the same week.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { logError, logInfo, messageOf } from "../lib/log";
import { writeWeeklyFeatureDraft } from "../lib/post-drafts";

type FindingRow = {
  finding_id: string;
  agent_name: string;
  agent_token_address: string;
  title: string;
  severity: string;
  summary: string;
};

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  const findingId = positional[0];
  const rationale = positional[1];
  if (findingId === undefined || rationale === undefined || rationale.length === 0) {
    throw new Error('usage: feature-finding.ts <findingId> "<rationale>" [--apply]');
  }

  const handle = process.env["OPERATOR_HANDLE"] ?? "operator";
  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set — populate apps/web/.env.local");
  }
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const weekStart = currentIsoWeekMondayUtc();
    // eslint-disable-next-line no-console
    console.log(`week_start: ${weekStart}`);
    // eslint-disable-next-line no-console
    console.log(`finding_id: ${findingId}`);
    // eslint-disable-next-line no-console
    console.log(`curated_by: ${handle}`);
    // eslint-disable-next-line no-console
    console.log(`rationale: ${rationale}`);

    const finding = await pool.query<FindingRow>(
      `SELECT finding_id, agent_name, agent_token_address, title, severity, summary
       FROM agent_findings
       WHERE finding_id = $1`,
      [findingId],
    );
    const row = finding.rows[0];
    if (row === undefined) {
      throw new Error(`agent_findings row not found: ${findingId}`);
    }

    if (!apply) {
      // eslint-disable-next-line no-console
      console.log("\ndry-run — pass --apply to mutate.");
      return;
    }

    await pool.query(
      `INSERT INTO weekly_features (week_start, finding_id, curated_by, rationale, featured_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (week_start) DO UPDATE
       SET finding_id = EXCLUDED.finding_id,
           curated_by = EXCLUDED.curated_by,
           rationale = EXCLUDED.rationale,
           featured_at = now()`,
      [weekStart, findingId, handle, rationale],
    );

    const draftPath = await writeWeeklyFeatureDraft({
      agentName: row.agent_name,
      agentTokenAddress: row.agent_token_address,
      findingTitle: row.title,
      severity: row.severity,
      summary: row.summary,
    });
    logInfo("feature_finding.set", { weekStart, findingId, handle, draftPath });
    // eslint-disable-next-line no-console
    console.log("done.");
  } finally {
    await pool.end();
  }
}

function currentIsoWeekMondayUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  if (dayNum !== 1) {
    d.setUTCDate(d.getUTCDate() - (dayNum - 1));
  }
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  logError("feature_finding.failed", { message: messageOf(err) });
  process.exit(1);
});
