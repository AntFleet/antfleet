/**
 * Admin tool — seed a row into `outgoing_prs` so the cron sweep can
 * track the merge state of an upstream PR opened by antfleet-ops on
 * a third-party repo (where the GitHub App is not installed).
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/seed-outgoing-pr.ts \
 *     <source-finding-id> <upstream-owner> <upstream-repo> <upstream-pr-number> <branch-on-fork>
 *
 * Example:
 *   pnpm exec tsx scripts/seed-outgoing-pr.ts \
 *     abcd1234-0 Liquid-Protocol-Ops agent-autonomopoly 3 \
 *     fix/threshold-harmonization
 *
 * Idempotent on (upstream_owner, upstream_repo, upstream_pr_number) —
 * re-running with the same args is a no-op. Reads DATABASE_URL from
 * apps/web/.env.local.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    console.error(
      "usage: pnpm exec tsx scripts/seed-outgoing-pr.ts <source-finding-id> <upstream-owner> <upstream-repo> <upstream-pr-number> <branch-on-fork>",
    );
    process.exit(2);
  }
  const [sourceFindingId, owner, repo, prNumberStr, branchOnFork] = args as [
    string,
    string,
    string,
    string,
    string,
  ];
  const prNumber = Number.parseInt(prNumberStr, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`invalid upstream-pr-number: ${prNumberStr}`);
    process.exit(2);
  }

  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { outgoingPrs } = await import("../db/schema");

  const existing = await db
    .select({ id: outgoingPrs.id, status: outgoingPrs.status })
    .from(outgoingPrs)
    .where(
      and(
        eq(outgoingPrs.upstreamOwner, owner),
        eq(outgoingPrs.upstreamRepo, repo),
        eq(outgoingPrs.upstreamPrNumber, prNumber),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    console.log(
      `[noop] outgoing_prs row already exists for ${owner}/${repo}#${prNumber} (id=${existing[0]!.id}, status=${existing[0]!.status}).`,
    );
    return;
  }

  const inserted = await db
    .insert(outgoingPrs)
    .values({
      sourceFindingId,
      upstreamOwner: owner,
      upstreamRepo: repo,
      upstreamPrNumber: prNumber,
      branchOnFork,
    })
    .returning({ id: outgoingPrs.id });
  const row = inserted[0];
  if (row === undefined) {
    console.error("insert returned no row");
    process.exit(1);
  }

  console.log(
    `[seeded] outgoing_prs row inserted: id=${row.id} source=${sourceFindingId} upstream=${owner}/${repo}#${prNumber} branch=${branchOnFork}`,
  );
  console.log(
    "Next cron sweep tick will poll the upstream PR's merge state. View at https://www.antfleet.dev/receipts once merged.",
  );
}

if (process.argv[1]?.endsWith("seed-outgoing-pr.ts")) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
