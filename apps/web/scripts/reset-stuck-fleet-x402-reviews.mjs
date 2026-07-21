#!/usr/bin/env node
// Reset fleet-commit x402 reviews stuck in processing_status=pending so the
// next hunter dispatch re-runs inference (after GITHUB_PUBLIC_TOKEN is set).
//
// Usage:
//   node --env-file=.env.probe scripts/reset-stuck-fleet-x402-reviews.mjs
//   node --env-file=.env.probe scripts/reset-stuck-fleet-x402-reviews.mjs --apply

import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

const TARGETS = [
  ["berachain", "beacon-kit", "d76f19676f784dc6ebb176792b3226db803aa5df"],
  ["pcaversaccio", "hardhat-project-template-ts", "e37f00a14f40f8c0bf282b2250acf96a12c0fd65"],
  ["pcaversaccio", "create2deployer", "bcf9c55f9a26c6f03356625548e16a8d9297410a"],
];

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.includes("ep-crimson-hall") && apply) {
  console.error("refusing --apply: DATABASE_URL must point at prod Neon (ep-crimson-hall)");
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

for (const [owner, repo, sha] of TARGETS) {
  const jobs = await pool.query(
    `
    SELECT job_id, status, created_at
    FROM review_jobs
    WHERE lower(repo_owner) = lower($1)
      AND lower(repo_name) = lower($2)
      AND lower(sha) = lower($3)
      AND pr_number = 0
    ORDER BY created_at DESC
  `,
    [owner, repo, sha],
  );
  console.log(`${owner}/${repo}: ${jobs.rowCount} review_job(s)`);
  for (const job of jobs.rows) {
    console.log(`  job ${job.job_id} status=${job.status}`);
    if (!apply) continue;
    await pool.query(`DELETE FROM review_jobs WHERE job_id = $1`, [job.job_id]);
    console.log(`  deleted job ${job.job_id}`);
  }

  const r = await pool.query(
    `
    SELECT review_id, processing_status, created_at
    FROM reviews
    WHERE lower(owner) = lower($1)
      AND lower(repo) = lower($2)
      AND lower(commit_sha) = lower($3)
      AND pr_number = 0
    LIMIT 1
  `,
    [owner, repo, sha],
  );
  const row = r.rows[0];
  if (!row) {
    console.log(`  no review row`);
    continue;
  }
  console.log(`  review=${String(row.review_id).slice(0, 8)} status=${row.processing_status}`);
  if (!apply) continue;
  await pool.query(`DELETE FROM reviews WHERE review_id = $1`, [row.review_id]);
  console.log(`  deleted review ${row.review_id}`);
}

if (!apply) {
  console.log("\nDry run only. Re-run with --apply to delete stuck jobs and reviews.");
}

await pool.end();
