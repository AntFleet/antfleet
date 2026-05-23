#!/usr/bin/env tsx
// Apply migration 0024 (review_jobs) to the dev DB.
// Usage: pnpm exec tsx scripts/apply-migration-0024.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

dotenv.config({ path: join(__dirname, "../.env.local") });

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const host = url.replace(/^postgresql:\/\/[^@]+@([^/?]+).*/, "$1");
console.log("Target host:", host);

const PROD_PATTERNS = ["neon-fulvous-zebra", "solitary-dew-96858656"];
if (PROD_PATTERNS.some((p) => host.includes(p))) {
  console.error("REFUSING to run against prod-looking host:", host);
  process.exit(1);
}

const sqlFile = readFileSync(
  join(__dirname, "../db/migrations/0024_review_jobs.sql"),
  "utf-8",
);

const dryRun = !process.argv.includes("--apply");

if (dryRun) {
  console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
  console.log(sqlFile);
  process.exit(0);
}

const sql = neon(url);

async function main() {
  console.log("Applying migration 0024_review_jobs...");
  await sql(sqlFile);
  console.log("Migration 0024 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
