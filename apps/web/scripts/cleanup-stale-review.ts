/**
 * Admin tool — mark all open finding_status rows attached to a given
 * review_id as 'superseded'. Used when the underlying repo/install no
 * longer exists (uninstalled App, transferred repo, smoke-test
 * artifact) and Sweeper's reaction polling keeps erroring against an
 * installation that won't authenticate.
 *
 * 'superseded' is one of the schema's three legal status values
 * (open | closed | superseded). Sweeper only acts on status='open',
 * so this stops the noise without losing the row (audit trail
 * preserved; we can still see the finding ever existed).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/cleanup-stale-review.ts <review-id>
 *
 * Dry-run by default; pass --apply to actually update.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const reviewId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!reviewId) {
    console.error("usage: cleanup-stale-review.ts <review-id> [--apply]");
    process.exit(2);
  }

  const { db } = await import("../db/index");
  const { findingStatus } = await import("../db/schema");
  const { and, eq } = await import("drizzle-orm");

  const open = await db
    .select({
      findingId: findingStatus.findingId,
      status: findingStatus.status,
      title: findingStatus.title,
    })
    .from(findingStatus)
    .where(and(eq(findingStatus.reviewId, reviewId), eq(findingStatus.status, "open")));

  console.log(`\n[review ${reviewId}] open finding_status rows: ${open.length}`);
  for (const r of open) {
    console.log(`  ${r.findingId}  ${r.title.slice(0, 60)}`);
  }

  if (open.length === 0) {
    console.log("\nnothing to do.");
    return;
  }

  if (!apply) {
    console.log("\ndry-run — pass --apply to mark these as 'superseded'.");
    return;
  }

  const updated = await db
    .update(findingStatus)
    .set({ status: "superseded" })
    .where(and(eq(findingStatus.reviewId, reviewId), eq(findingStatus.status, "open")))
    .returning({ findingId: findingStatus.findingId });

  console.log(`\nmarked ${updated.length} rows as 'superseded'.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
