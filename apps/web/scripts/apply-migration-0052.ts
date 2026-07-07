#!/usr/bin/env tsx
// Apply migration 0052 (third-model adjudication → two_of_three sub-tier) to the DB.
// Usage: pnpm exec tsx scripts/apply-migration-0052.ts [--apply]
// Without --apply, prints the SQL and exits (dry run).

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import * as dotenv from "dotenv";
import { assertSafeToApply } from "../db/migrations/safety";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);

dotenv.config({ path: join(selfDir, "../.env.local") });

const sqlFile = readFileSync(
  join(selfDir, "../db/migrations/0052_third_model_adjudication.sql"),
  "utf-8",
);

async function main() {
  const { url, apply } = await assertSafeToApply();
  if (!apply) {
    console.log("\n--- DRY RUN (pass --apply to execute) ---\n");
    console.log(sqlFile);
    return;
  }
  const sql = neon(url);
  console.log("Applying migration 0052_third_model_adjudication...");
  const statements = sqlFile
    .split(";")
    .map((s) => s.trim())
    .map((s) => s.replace(/^(--[^\n]*\n)+/, "").trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    console.log(`  Running: ${stmt.slice(0, 60)}...`);
    await sql.query(stmt);
  }
  console.log("Migration 0052 applied successfully.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
