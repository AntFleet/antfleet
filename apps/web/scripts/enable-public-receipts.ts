/**
 * Admin tool — enable `public_receipt = true` for an owner's reviews, so
 * their closed findings begin appearing on the public /receipts page.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/enable-public-receipts.ts <owner>
 *   pnpm exec tsx scripts/enable-public-receipts.ts <owner> <repo>
 *
 * Owner-only form opts in every repo under that GitHub login/org. The
 * owner+repo form scopes to a single repo. Both forms are idempotent —
 * re-running has no effect on rows already at public_receipt = true.
 *
 * Until the v1.5 customer dashboard ships, this is how design-partner
 * opt-in is recorded. The /policy page tells customers to email
 * privacy@antfleet.dev to request the flip; this is the script you run
 * to honor that request. Always read pre-state, confirm the row count
 * matches the request, then re-read post-state. Reads DATABASE_URL from
 * apps/web/.env.local.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const [ownerArg, repoArg] = process.argv.slice(2);
  if (ownerArg === undefined || ownerArg.length === 0) {
    console.error("usage: pnpm exec tsx scripts/enable-public-receipts.ts <owner> [<repo>]");
    process.exit(2);
  }

  // Dynamic imports so dotenv runs before db/index.ts evaluates its
  // DATABASE_URL guard.
  const { and, eq, sql } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { reviews } = await import("../db/schema");

  const scopeLabel =
    repoArg === undefined ? `owner=${ownerArg}` : `owner=${ownerArg} repo=${repoArg}`;
  console.log(`\n[scope] ${scopeLabel}`);

  const ownerMatch = eq(reviews.owner, ownerArg);
  const repoMatch = repoArg === undefined ? undefined : eq(reviews.repo, repoArg);
  const scopeCondition = repoMatch === undefined ? ownerMatch : and(ownerMatch, repoMatch);

  // Pre-state: how many rows are in scope, and how many are already public?
  const preRows = await db
    .select({
      total: sql<number>`count(*)::int`.as("total"),
      alreadyPublic: sql<number>`count(*) filter (where ${reviews.publicReceipt})::int`.as(
        "already_public",
      ),
    })
    .from(reviews)
    .where(scopeCondition);

  const pre = preRows[0] ?? { total: 0, alreadyPublic: 0 };
  console.log(
    `[pre-state] ${pre.total} review(s) match scope; ${pre.alreadyPublic} already public.`,
  );

  if (pre.total === 0) {
    console.log("\n[abort] no rows in scope. nothing to do.");
    return;
  }

  // Apply the flip, returning the rows we actually changed.
  const flipCondition =
    repoMatch === undefined
      ? and(ownerMatch, eq(reviews.publicReceipt, false))
      : and(ownerMatch, repoMatch, eq(reviews.publicReceipt, false));

  const updated = await db
    .update(reviews)
    .set({ publicReceipt: true })
    .where(flipCondition)
    .returning({
      reviewId: reviews.reviewId,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
    });

  console.log(`\n[update] flipped public_receipt for ${updated.length} row(s).`);
  if (updated.length > 0) {
    console.table(updated);
  }

  // Post-state: confirm.
  const postRows = await db
    .select({
      total: sql<number>`count(*)::int`.as("total"),
      nowPublic: sql<number>`count(*) filter (where ${reviews.publicReceipt})::int`.as(
        "now_public",
      ),
    })
    .from(reviews)
    .where(scopeCondition);

  const post = postRows[0] ?? { total: 0, nowPublic: 0 };
  console.log(`[post-state] ${post.total} review(s) in scope; ${post.nowPublic} now public.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
