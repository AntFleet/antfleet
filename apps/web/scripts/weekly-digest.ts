/**
 * Operator weekly digest — per-install metrics over the last 7 days.
 * Run Monday mornings to drive the Phase 2 weekly review per AGENTS.md
 * §5 ("Weekly metrics review: per-repo recall, noise, time-to-close").
 *
 * Per active install (any review in the last 7d):
 *   - reviews run, files reviewed, avg + p95 wall time
 *   - findings agreed (posted), findings still open, findings closed
 *   - reactions breakdown (thumbs_up / thumbs_down / eyes / other)
 *   - partner replies (count, last reply preview)
 *   - onboarder events (welcome / first-review / 7-day check-in counts)
 *
 * Operator-only — prints raw owner/repo strings. Do not paste output
 * into public channels.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/weekly-digest.ts          # last 7 days
 *   pnpm exec tsx scripts/weekly-digest.ts --days=14 # custom window
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

const DEFAULT_DAYS = 7;

async function main() {
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = daysArg ? Number(daysArg.slice("--days=".length)) : DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`usage: weekly-digest.ts [--days=N]`);
    process.exit(2);
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  console.log(
    `\nAntFleet · weekly digest · last ${days} days (since ${since.toISOString().slice(0, 10)})\n`,
  );

  const { db } = await import("../db/index");
  const { findingStatus, maintainerReactions, onboardingEvents, reviews } =
    await import("../db/schema");
  const { and, count, desc, eq, gte, sql, isNotNull } = await import("drizzle-orm");
  const { precisionWindow } = await import("../db/queries");

  // 1. Active installs in the window — distinct (installation_id, owner, repo)
  // tuples from reviews with a review row created since `since`.
  const installs = await db
    .selectDistinct({
      installationId: reviews.installationId,
      owner: reviews.owner,
      repo: reviews.repo,
    })
    .from(reviews)
    .where(
      and(
        gte(reviews.createdAt, since),
        isNotNull(reviews.installationId),
        isNotNull(reviews.owner),
        isNotNull(reviews.repo),
      ),
    );

  if (installs.length === 0) {
    console.log(
      "(no installs with activity in the window — Onboarder may be silent, or no real PRs landed)\n",
    );
    return;
  }

  for (const inst of installs) {
    if (inst.installationId === null || inst.owner === null || inst.repo === null) {
      continue;
    }
    const installationId = inst.installationId;
    const owner = inst.owner;
    const repo = inst.repo;

    // Per-install rollups. One query block per dimension keeps the SQL
    // simple at the cost of round-trips; weekly cadence + single-digit
    // install count makes this trade fine.
    const [
      reviewStats,
      agreedCount,
      openCount,
      closedCount,
      reactionRows,
      replyRows,
      onboarderRows,
    ] = await Promise.all([
      db
        .select({
          n: count(reviews.reviewId),
          avgMs: sql<number>`avg(${reviews.timingMs})`,
          maxMs: sql<number>`max(${reviews.timingMs})`,
        })
        .from(reviews)
        .where(
          and(
            eq(reviews.installationId, installationId),
            eq(reviews.owner, owner),
            eq(reviews.repo, repo),
            gte(reviews.createdAt, since),
          ),
        ),
      db
        .select({ n: count(findingStatus.id) })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(and(eq(reviews.installationId, installationId), gte(reviews.createdAt, since))),
      db
        .select({ n: count(findingStatus.id) })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(
          and(
            eq(reviews.installationId, installationId),
            gte(reviews.createdAt, since),
            eq(findingStatus.status, "open"),
          ),
        ),
      db
        .select({ n: count(findingStatus.id) })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(
          and(
            eq(reviews.installationId, installationId),
            gte(reviews.createdAt, since),
            eq(findingStatus.status, "closed"),
          ),
        ),
      db
        .select({
          actionTaken: maintainerReactions.actionTaken,
          n: count(maintainerReactions.reactionId),
        })
        .from(maintainerReactions)
        .innerJoin(reviews, eq(maintainerReactions.reviewId, reviews.reviewId))
        .where(and(eq(reviews.installationId, installationId), gte(reviews.createdAt, since)))
        .groupBy(maintainerReactions.actionTaken),
      db
        .select({
          createdAt: onboardingEvents.createdAt,
          toolOutput: onboardingEvents.toolOutput,
        })
        .from(onboardingEvents)
        .where(
          and(
            eq(onboardingEvents.installationId, installationId),
            eq(onboardingEvents.owner, owner),
            eq(onboardingEvents.repo, repo),
            eq(onboardingEvents.eventType, "partner_reply"),
            gte(onboardingEvents.createdAt, since),
          ),
        )
        .orderBy(desc(onboardingEvents.createdAt)),
      db
        .select({
          eventType: onboardingEvents.eventType,
          n: count(onboardingEvents.id),
        })
        .from(onboardingEvents)
        .where(
          and(
            eq(onboardingEvents.installationId, installationId),
            eq(onboardingEvents.owner, owner),
            eq(onboardingEvents.repo, repo),
            gte(onboardingEvents.createdAt, since),
          ),
        )
        .groupBy(onboardingEvents.eventType),
    ]);

    const r = reviewStats[0];
    const reactionsByKind = new Map(reactionRows.map((row) => [row.actionTaken, row.n]));
    const onboarderByType = new Map(onboarderRows.map((row) => [row.eventType, row.n]));

    console.log(`━━ ${owner}/${repo}  (install ${installationId}) ━━`);
    console.log(
      `  reviews        : ${r?.n ?? 0}` +
        (r && r.n > 0
          ? `   (avg ${Math.round(Number(r.avgMs ?? 0) / 1000)}s, max ${Math.round(Number(r.maxMs ?? 0) / 1000)}s)`
          : ""),
    );
    console.log(
      `  findings       : ${agreedCount[0]?.n ?? 0} agreed   ${openCount[0]?.n ?? 0} open   ${closedCount[0]?.n ?? 0} closed`,
    );
    if (reactionRows.length === 0) {
      console.log(`  reactions      : —`);
    } else {
      const parts: string[] = [];
      for (const kind of [
        "reaction:thumbs_up",
        "reaction:thumbs_down",
        "reaction:eyes",
        "reaction:heart",
        "reaction:rocket",
        "reaction:laugh",
        "reaction:confused",
        "reaction:hooray",
      ]) {
        const n = reactionsByKind.get(kind);
        if (n !== undefined && n > 0) {
          parts.push(`${kind.replace("reaction:", "")}:${n}`);
        }
      }
      console.log(`  reactions      : ${parts.join("  ")}`);
    }
    console.log(
      `  onboarder      : ${["install_welcome", "first_review_summary", "check_in_7d"]
        .map((t) => `${t}=${onboarderByType.get(t) ?? 0}`)
        .join("  ")}`,
    );
    console.log(`  partner_replies: ${replyRows.length}`);
    if (replyRows.length > 0) {
      const latest = replyRows[0];
      if (latest !== undefined) {
        const out = latest.toolOutput as { body?: string; sender_login?: string };
        const body = (out.body ?? "").replace(/\s+/g, " ").slice(0, 120);
        console.log(
          `    latest ${latest.createdAt.toISOString().slice(0, 10)} by ${out.sender_login ?? "?"}: ${body}${(out.body ?? "").length > 120 ? "…" : ""}`,
        );
      }
    }
    console.log("");
  }

  // ── Precision metric (Step 0.5, item 7) ──────────────────────────────────
  // Global dismiss-rate per severity tier over the same window. Internal only.
  // thumbsDownCount is channel C (un-attributable, not merged into rate).
  const pw = await precisionWindow(since, null);
  console.log(`━━ precision signal (last ${days} days) ━━`);
  for (const t of pw.tiers) {
    const rateStr = t.postedCount > 0 ? `${(t.dismissRate * 100).toFixed(1)}%` : "—";
    console.log(
      `  ${t.source.padEnd(12)} ${t.tier.padEnd(8)}: posted=${t.postedCount}  dismissed=${t.dismissedCount}  rate=${rateStr}`,
    );
  }
  console.log(`  thumbs_down (ch C, secondary): ${pw.thumbsDownCount}`);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
