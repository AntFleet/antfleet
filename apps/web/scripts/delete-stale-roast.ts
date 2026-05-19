/**
 * One-off — delete a specific roast_submissions row + the agent_findings
 * rows it produced. Built to clean up `lukeBC27Sokln5obS9m1u`, a
 * factory-watcher-sourced submission whose repo (`digitalgoods221/motika`)
 * was attributed to a Liquid memecoin token by repo-discovery's
 * github_search false-positive. The repo is unrelated to any AntFleet
 * agent; the findings were published under a roast we never should have
 * queued.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/delete-stale-roast.ts <submissionId>            # dry-run
 *   pnpm exec tsx scripts/delete-stale-roast.ts <submissionId> --apply    # mutate
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const submissionId = args.find((a) => !a.startsWith("--"));
  if (submissionId === undefined || submissionId.length === 0) {
    throw new Error("usage: delete-stale-roast.ts <submissionId> [--apply]");
  }

  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set — populate apps/web/.env.local");
  }
  const host = databaseUrl.match(/@([^/]+)/)?.[1] ?? "(unknown)";
  // eslint-disable-next-line no-console
  console.log(`target host: ${host}`);
  // eslint-disable-next-line no-console
  console.log(`submission id: ${submissionId}`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const submission = await pool.query<{
      repo_full_name: string;
      status: string;
      source: string;
    }>("SELECT repo_full_name, status, source FROM roast_submissions WHERE id = $1", [
      submissionId,
    ]);
    if ((submission.rows[0] ?? null) === null) {
      // eslint-disable-next-line no-console
      console.log("(submission row not present — nothing to delete)");
      return;
    }
    const pseudoKey = `roast:${submissionId}`;
    const findings = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM agent_findings WHERE agent_token_address = $1",
      [pseudoKey],
    );
    // eslint-disable-next-line no-console
    console.log(
      `submission: repo=${submission.rows[0]?.repo_full_name} status=${submission.rows[0]?.status} source=${submission.rows[0]?.source}`,
    );
    // eslint-disable-next-line no-console
    console.log(`agent_findings to delete (key=${pseudoKey}): ${findings.rows[0]?.count ?? 0}`);

    if (!apply) {
      // eslint-disable-next-line no-console
      console.log("\ndry-run — pass --apply to mutate.");
      return;
    }

    await pool.query("DELETE FROM agent_findings WHERE agent_token_address = $1", [pseudoKey]);
    await pool.query("DELETE FROM roast_submissions WHERE id = $1", [submissionId]);

    // eslint-disable-next-line no-console
    console.log("done.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
