/**
 * Admin tool — dump the newest 15 finding_status rows joined to their
 * parent reviews row. Used to diagnose "sweep returned closed:0 but I
 * expected closure" situations: shows the open/closed status, the
 * review commit SHA the sweeper compares against, the closing SHA if
 * already detected, and the public_receipt gate state (which decides
 * whether a closed receipt actually surfaces on /receipts).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/inspect-finding-status.ts
 *
 * Reads DATABASE_URL from apps/web/.env.local. Result is operator-only;
 * does not expose anything beyond what is already privacy-safe on the
 * /receipts page (repo names appear in plaintext here because this is
 * an operator script, not a public surface).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const { db } = await import("../db/index");
  const { findingStatus, reviews } = await import("../db/schema");
  const { eq, desc } = await import("drizzle-orm");

  const rows = await db
    .select({
      findingId: findingStatus.findingId,
      status: findingStatus.status,
      title: findingStatus.title,
      severity: findingStatus.severity,
      reviewId: findingStatus.reviewId,
      commitSha: reviews.commitSha,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
      installationId: reviews.installationId,
      publicReceipt: reviews.publicReceipt,
      closureSha: findingStatus.closureSha,
      closureDetectedAt: findingStatus.closureDetectedAt,
      createdAt: findingStatus.createdAt,
    })
    .from(findingStatus)
    .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
    .orderBy(desc(findingStatus.createdAt))
    .limit(15);

  console.log("\n[finding_status rows, newest first]\n");
  for (const r of rows) {
    console.log(`finding_id     : ${r.findingId}`);
    console.log(`  status       : ${r.status}`);
    console.log(`  title        : ${r.title.slice(0, 60)}`);
    console.log(`  review_id    : ${r.reviewId}`);
    console.log(`  commit_sha   : ${r.commitSha}`);
    console.log(`  owner/repo   : ${r.owner}/${r.repo}  PR #${r.prNumber}`);
    console.log(`  install_id   : ${r.installationId}`);
    console.log(`  public       : ${r.publicReceipt}`);
    console.log(`  closure_sha  : ${r.closureSha ?? "—"}`);
    console.log(`  closure_at   : ${r.closureDetectedAt?.toISOString() ?? "—"}`);
    console.log(`  created_at   : ${r.createdAt.toISOString()}`);
    console.log("");
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
