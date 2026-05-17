/**
 * Admin tool — rename the owner on every reviews row that points at a
 * specific (old-owner, repo) pair. Used when a repo is transferred between
 * GitHub accounts/orgs (Augustas11/antfleet → AntFleet/antfleet, etc.).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/migrate-repo-owner.ts <old-owner> <repo> <new-owner>
 *
 * Example:
 *   pnpm exec tsx scripts/migrate-repo-owner.ts Augustas11 antfleet AntFleet
 *
 * Idempotent — rows already at new-owner are silently skipped. Reads
 * DATABASE_URL from apps/web/.env.local. Reports per-row diff so the
 * caller can sanity-check before/after.
 *
 * Note: this only updates the reviews.owner column. The repo_hash
 * (sha256 of owner/repo) is NOT recomputed because it serves as the
 * stable public identifier on /receipts; rewriting it would orphan
 * pre-rename closure receipts from their per-repo aggregates. New
 * reviews after this migration will use the new repo_hash; historical
 * ones keep the old one. Acceptable tradeoff per §10 privacy boundary.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const [oldOwner, repoName, newOwner] = process.argv.slice(2);
  if (oldOwner === undefined || repoName === undefined || newOwner === undefined) {
    console.error(
      "usage: pnpm exec tsx scripts/migrate-repo-owner.ts <old-owner> <repo> <new-owner>",
    );
    process.exit(2);
  }

  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { reviews } = await import("../db/schema");

  // Pre-state — count rows by current owner for this repo.
  const pre = await db
    .select({
      reviewId: reviews.reviewId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
    })
    .from(reviews)
    .where(eq(reviews.repo, repoName));

  console.log(`\n[scope] repo=${repoName}`);
  console.log(`[pre-state] ${pre.length} review(s) under repo=${repoName}:`);
  console.table(pre.map((r) => ({
    reviewId: r.reviewId,
    owner: r.owner,
    pr: r.prNumber,
  })));

  const targetCount = pre.filter((r) => r.owner === oldOwner).length;
  if (targetCount === 0) {
    console.log(`\n[abort] no rows match owner=${oldOwner}. nothing to do.`);
    return;
  }
  console.log(`\n[plan] flip owner ${oldOwner} → ${newOwner} on ${targetCount} row(s)`);

  const updated = await db
    .update(reviews)
    .set({ owner: newOwner })
    .where(and(eq(reviews.owner, oldOwner), eq(reviews.repo, repoName)))
    .returning({
      reviewId: reviews.reviewId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
    });

  console.log(`\n[update] migrated ${updated.length} row(s).`);
  console.table(updated.map((r) => ({
    reviewId: r.reviewId,
    owner: r.owner,
    pr: r.prNumber,
  })));

  // Post-state — read back the affected rows to confirm.
  const post = await db
    .select({
      reviewId: reviews.reviewId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
    })
    .from(reviews)
    .where(eq(reviews.repo, repoName));

  console.log(`\n[post-state] ${post.length} review(s) under repo=${repoName}:`);
  console.table(post.map((r) => ({
    reviewId: r.reviewId,
    owner: r.owner,
    pr: r.prNumber,
  })));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
