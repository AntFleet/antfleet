import type { Pool } from "@neondatabase/serverless";
import { logInfo, logWarn, messageOf } from "./log";
import { writeWeeklyFeatureDraft } from "./post-drafts";

const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, med: 2, high: 3 };

export type CurateWeeklyResult =
  | { status: "skipped_existing"; weekStart: string }
  | { status: "no_candidates"; weekStart: string }
  | { status: "dry_run"; weekStart: string; pickedFindingId: string; rationale: string }
  | {
      status: "featured";
      weekStart: string;
      pickedFindingId: string;
      rationale: string;
      draftPath: string | null;
    };

export type CandidateRow = {
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

export async function curateWeekly(opts: {
  pool: Pool;
  apply: boolean;
  now?: Date;
}): Promise<CurateWeeklyResult> {
  const weekStart = currentIsoWeekMondayUtc(opts.now);

  const existing = await opts.pool.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM weekly_features WHERE week_start = $1",
    [weekStart],
  );
  if ((existing.rows[0]?.count ?? 0) > 0) {
    return { status: "skipped_existing", weekStart };
  }

  const candidates = await opts.pool.query<CandidateRow>(`
    SELECT finding_id, agent_name, agent_token_address, title, severity, summary,
           upstream_pr_url, upstream_merged_sha, published_at
    FROM agent_findings
    WHERE published_at >= now() - interval '7 days'
      AND lower(agent_token_address) NOT LIKE 'roast:%'
  `);
  if (candidates.rows.length === 0) {
    logInfo("curate_weekly.no_candidates", { weekStart });
    return { status: "no_candidates", weekStart };
  }

  const top = candidates.rows.toSorted(compareCandidates)[0]!;
  const rationale = autoRationale(top);
  if (!opts.apply) {
    return { status: "dry_run", weekStart, pickedFindingId: top.finding_id, rationale };
  }

  await opts.pool.query(
    `INSERT INTO weekly_features (week_start, finding_id, curated_by, rationale, featured_at)
     VALUES ($1, $2, 'auto', $3, now())
     ON CONFLICT (week_start) DO NOTHING`,
    [weekStart, top.finding_id, rationale],
  );

  let draftPath: string | null = null;
  try {
    draftPath = await writeWeeklyFeatureDraft({
      agentName: top.agent_name,
      agentTokenAddress: top.agent_token_address,
      findingTitle: top.title,
      severity: top.severity,
      summary: top.summary,
    });
  } catch (err) {
    logWarn("curate_weekly.draft_failed", {
      weekStart,
      findingId: top.finding_id,
      message: messageOf(err),
    });
  }

  logInfo("curate_weekly.featured", {
    weekStart,
    findingId: top.finding_id,
    draftPath,
  });
  return {
    status: "featured",
    weekStart,
    pickedFindingId: top.finding_id,
    rationale,
    draftPath,
  };
}

export function compareCandidates(a: CandidateRow, b: CandidateRow): number {
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

export function currentIsoWeekMondayUtc(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  if (dayNum !== 1) {
    d.setUTCDate(d.getUTCDate() - (dayNum - 1));
  }
  return d.toISOString().slice(0, 10);
}
