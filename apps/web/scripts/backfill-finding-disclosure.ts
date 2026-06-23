/**
 * Admin tool — backfill finding_disclosure rows for historical findings.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/backfill-finding-disclosure.ts          # dry-run
 *   pnpm exec tsx scripts/backfill-finding-disclosure.ts --apply  # write
 *
 * Historical safety: existing findings become `none` so public visibility keeps
 * inheriting reviews.public_receipt exactly as it did before the side table.
 * This intentionally does NOT auto-embargo old rows.
 */
import * as dotenv from "dotenv";
import { eq, isNull, sql } from "drizzle-orm";

dotenv.config({ path: ".env.local", quiet: true });

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const { db } = await import("../db/index");
  const { findingDisclosure, findingDisclosureLog, findingStatus, reviews } =
    await import("../db/schema");

  const candidates = await db
    .select({
      findingId: findingStatus.findingId,
      reviewId: findingStatus.reviewId,
      commitSha: reviews.commitSha,
      publicReceipt: reviews.publicReceipt,
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(reviews.reviewId, findingStatus.reviewId))
    .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
    .where(isNull(findingDisclosure.findingId));

  console.log(
    `[pre-state] ${candidates.length} missing disclosure row(s): none=${candidates.length}`,
  );
  if (!apply) {
    console.log("[mode] dry-run. Re-run with --apply to insert rows.");
    return;
  }

  let inserted = 0;
  for (const row of candidates) {
    const state = "none";
    const now = new Date();
    const created = await db.transaction(async (tx) => {
      const result = await tx
        .insert(findingDisclosure)
        .values({
          findingId: row.findingId,
          reviewId: row.reviewId,
          state,
          enteredAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: findingDisclosure.findingId })
        .returning({ findingId: findingDisclosure.findingId });
      if (result.length === 0) return false;
      await tx.insert(findingDisclosureLog).values({
        findingId: row.findingId,
        fromState: null,
        toState: state,
        actorType: "system",
        actorId: "backfill-finding-disclosure",
        reason: "historical finding backfill preserving legacy publicReceipt behavior",
        atSha: row.commitSha,
        metadata: {
          source: "backfill-finding-disclosure",
          legacyPublicReceipt: row.publicReceipt,
        },
        createdAt: now,
      });
      return true;
    });
    if (created) inserted += 1;
  }

  const counts = await db
    .select({
      state: findingDisclosure.state,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(findingDisclosure)
    .groupBy(findingDisclosure.state);
  console.log(`[post-state] inserted=${inserted}`);
  for (const row of counts) {
    console.log(`  ${row.state}: ${row.count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
