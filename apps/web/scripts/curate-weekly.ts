/**
 * Auto-curate the receipt of the week. Picks the top finding from the past 7d
 * by severity → upstream-PR-existence → upstream-merge → recency, then inserts
 * a weekly_features row keyed on the current ISO week's Monday 00:00 UTC.
 *
 * Idempotent: if a row already exists for the current week (manual override
 * via feature-finding.ts ran earlier), this script skips.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/curate-weekly.ts            # dry-run
 *   pnpm exec tsx scripts/curate-weekly.ts --apply    # mutate
 *
 * Intended to run weekly via cron (Monday 00:00 UTC).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { logError, logInfo, logWarn, messageOf } from "../lib/log";
import { writeWeeklyFeatureDraft } from "../lib/post-drafts";

const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, med: 2, high: 3 };

type CandidateRow = {
  finding_id: string;
  agent_name: string;
  agent_token_address: string;
  title: string;
  severity: string;
  summary: string;
  upstream_pr_url: string | null;
  upstream_merged_sha: string | null;
  published_at: Date;
};

async function main() {
  const apply = process.argv.includes("--apply");
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

    const existing = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM weekly_features WHERE week_start = $1",
      [weekStart],
    );
    if ((existing.rows[0]?.count ?? 0) > 0) {
      // eslint-disable-next-line no-console
      console.log("(weekly_features row already present for this week — skipping)");
      return;
    }

    const candidates = await pool.query<CandidateRow>(`
      SELECT finding_id, agent_name, agent_token_address, title, severity, summary,
             upstream_pr_url, upstream_merged_sha, published_at
      FROM agent_findings
      WHERE published_at >= now() - interval '7 days'
        AND lower(agent_token_address) NOT LIKE 'roast:%'
    `);
    if (candidates.rows.length === 0) {
      logInfo("curate_weekly.no_candidates", { weekStart });
      // eslint-disable-next-line no-console
      console.log("(no eligible findings in last 7 days)");
      return;
    }

    const ranked = candidates.rows.toSorted(compareCandidates);
    const top = ranked[0]!;
    // eslint-disable-next-line no-console
    console.log(`picked: ${top.finding_id} (${top.severity}, ${top.agent_name})`);

    if (!apply) {
      // eslint-disable-next-line no-console
      console.log("\ndry-run — pass --apply to mutate.");
      return;
    }

    await pool.query(
      `INSERT INTO weekly_features (week_start, finding_id, curated_by, rationale, featured_at)
       VALUES ($1, $2, 'auto', $3, now())
       ON CONFLICT (week_start) DO NOTHING`,
      [weekStart, top.finding_id, autoRationale(top)],
    );

    try {
      const draftPath = await writeWeeklyFeatureDraft({
        agentName: top.agent_name,
        agentTokenAddress: top.agent_token_address,
        findingTitle: top.title,
        severity: top.severity,
        summary: top.summary,
      });
      logInfo("curate_weekly.featured", {
        weekStart,
        findingId: top.finding_id,
        draftPath,
      });
    } catch (err) {
      logWarn("curate_weekly.draft_failed", {
        weekStart,
        findingId: top.finding_id,
        message: messageOf(err),
      });
    }
    // eslint-disable-next-line no-console
    console.log("done.");
  } finally {
    await pool.end();
  }
}

function compareCandidates(a: CandidateRow, b: CandidateRow): number {
  const sevDelta = (SEVERITY_RANK[b.severity] ?? -1) - (SEVERITY_RANK[a.severity] ?? -1);
  if (sevDelta !== 0) return sevDelta;
  const aPr = a.upstream_pr_url !== null ? 1 : 0;
  const bPr = b.upstream_pr_url !== null ? 1 : 0;
  if (bPr !== aPr) return bPr - aPr;
  const aMerged = a.upstream_merged_sha !== null ? 1 : 0;
  const bMerged = b.upstream_merged_sha !== null ? 1 : 0;
  if (bMerged !== aMerged) return bMerged - aMerged;
  return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
}

function autoRationale(row: CandidateRow): string {
  const parts = [`${row.severity}`];
  if (row.upstream_merged_sha !== null) parts.push("upstream merged");
  else if (row.upstream_pr_url !== null) parts.push("upstream PR open");
  parts.push(`published ${new Date(row.published_at).toISOString().slice(0, 10)}`);
  return `auto: ${parts.join(" · ")}`;
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
  logError("curate_weekly.failed", { message: messageOf(err) });
  process.exit(1);
});
