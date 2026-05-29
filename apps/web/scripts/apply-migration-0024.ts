#!/usr/bin/env tsx
// Apply migration 0024 (review_jobs) to the dev DB.
// Usage: pnpm exec tsx scripts/apply-migration-0024.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../.env.local") });

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

const sqlFile = readFileSync(join(selfDir, "../db/migrations/0024_review_jobs.sql"), "utf-8");

const dryRun = !process.argv.includes("--apply");

if (dryRun) {
  console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
  console.log(sqlFile);
  process.exit(0);
}

const sql = neon(url);

async function main() {
  console.log("Applying migration 0024_review_jobs...");
  // Neon serverless driver can't run multiple statements in one call.
  // Split on semicolons and run each statement individually.
  const statements = sqlFile
    .split(";")
    .map((s) => s.trim())
    // Strip leading comment lines but keep the SQL that follows
    .map((s) => s.replace(/^(--[^\n]*\n)+/, "").trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    console.log(`  Running: ${stmt.slice(0, 60)}...`);
    await sql(stmt);
  }
  console.log("Migration 0024 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
