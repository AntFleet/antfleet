#!/usr/bin/env tsx
// Backfill absorbed-inline detection on existing closed outgoing_prs rows.
//
// Usage:
//   pnpm exec tsx scripts/backfill-absorbed-inline.ts             # dry run
//   pnpm exec tsx scripts/backfill-absorbed-inline.ts --apply     # write results
//
// Reads all outgoing_prs rows with status='closed' and closure_sha IS NULL,
// runs the LLM-judge detection, and reports results. With --apply, writes
// the detected closure fields back to the database.

import { eq, and, isNull } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

import { outgoingPrs } from "../db/schema";
import { detectAbsorbedInline, realAbsorbedInlineDeps } from "../lib/absorbed-inline";

const selfDir = dirname(fileURLToPath(import.meta.url));
// override: true is required when the parent shell pre-sets these env vars to
// empty (e.g. Claude Code session inheritance — ANTHROPIC_API_KEY is exported
// as ""). Without override, dotenv refuses to overwrite the empty value and
// the LLM judge silently fails. No effect in prod (Vercel sets env directly).
dotenv.config({ path: join(selfDir, "../.env.local"), override: true });

const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const dryRun = !process.argv.includes("--apply");
const sql = neon(url);
const db = drizzle(sql);

type BackfillResult = {
  id: string;
  upstream: string;
  absorbed: boolean;
  closureSha: string | null;
  confidence: number | null;
  reasoning: string | null;
};

async function main() {
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log();

  // Load unprocessed closed rows
  const rows = await db
    .select({
      id: outgoingPrs.id,
      upstreamOwner: outgoingPrs.upstreamOwner,
      upstreamRepo: outgoingPrs.upstreamRepo,
      upstreamPrNumber: outgoingPrs.upstreamPrNumber,
      openedAt: outgoingPrs.openedAt,
      branchOnFork: outgoingPrs.branchOnFork,
    })
    .from(outgoingPrs)
    .where(
      and(
        eq(outgoingPrs.status, "closed"),
        isNull(outgoingPrs.closureSha),
        isNull(outgoingPrs.closureMethod),
      ),
    );

  console.log(`Found ${rows.length} unprocessed closed rows.`);
  if (rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const deps = realAbsorbedInlineDeps();
  const results: BackfillResult[] = [];
  let absorbedCount = 0;
  let declinedCount = 0;

  for (const row of rows) {
    const label = `${row.upstreamOwner}/${row.upstreamRepo}#${row.upstreamPrNumber}`;
    console.log(`\nProcessing: ${label}`);

    const t0 = Date.now();
    const detection = await detectAbsorbedInline(
      {
        upstreamOwner: row.upstreamOwner,
        upstreamRepo: row.upstreamRepo,
        upstreamPrNumber: row.upstreamPrNumber,
        openedAt: row.openedAt,
        branchOnFork: row.branchOnFork,
      },
      deps,
    );
    const elapsed = Date.now() - t0;

    if (detection.absorbed) {
      console.log(
        `  ABSORBED: sha=${detection.commitSha.slice(0, 7)} ` +
          `confidence=${detection.confidence.toFixed(2)} ` +
          `(${elapsed}ms)`,
      );
      console.log(`  Reasoning: ${detection.reasoning}`);
      results.push({
        id: row.id,
        upstream: label,
        absorbed: true,
        closureSha: detection.commitSha,
        confidence: detection.confidence,
        reasoning: detection.reasoning,
      });
      absorbedCount++;

      if (!dryRun) {
        const now = new Date();
        await db
          .update(outgoingPrs)
          .set({
            status: "closed_absorbed",
            closureMethod: "absorbed_inline",
            closureSha: detection.commitSha,
            closureDetectedAt: now,
            closureConfidence: detection.confidence,
            closureNotes: detection.reasoning,
          })
          .where(eq(outgoingPrs.id, row.id));
        console.log("  Written to DB.");
      }
    } else {
      console.log(`  DECLINED: no matching upstream commit (${elapsed}ms)`);
      results.push({
        id: row.id,
        upstream: label,
        absorbed: false,
        closureSha: null,
        confidence: null,
        reasoning: null,
      });
      declinedCount++;

      if (!dryRun) {
        const now = new Date();
        await db
          .update(outgoingPrs)
          .set({
            closureMethod: "declined",
            closureDetectedAt: now,
          })
          .where(eq(outgoingPrs.id, row.id));
        console.log("  Written to DB.");
      }
    }
  }

  console.log("\n=== BACKFILL REPORT ===");
  console.log(`Total processed: ${results.length}`);
  console.log(`Absorbed:        ${absorbedCount}`);
  console.log(`Declined:        ${declinedCount}`);
  if (dryRun) {
    console.log("\n(Dry run — no DB writes. Pass --apply to commit.)");
  }

  // Reference-data validation
  console.log("\n=== REFERENCE DATA VALIDATION ===");
  for (const r of results) {
    if (r.upstream.includes("#5")) {
      const expected = "bab1e4b";
      const actual = r.closureSha?.slice(0, 7) ?? "(none)";
      const pass = actual === expected;
      console.log(`PR #5: expected ${expected}, got ${actual} — ${pass ? "PASS" : "FAIL"}`);
      if (!pass) {
        console.error("REFERENCE VALIDATION FAILED for PR #5. Halting.");
        process.exit(1);
      }
    }
    if (r.upstream.includes("#8")) {
      const expected = "7329b8a";
      const actual = r.closureSha?.slice(0, 7) ?? "(none)";
      const pass = actual === expected;
      console.log(`PR #8: expected ${expected}, got ${actual} — ${pass ? "PASS" : "FAIL"}`);
      if (!pass) {
        console.error("REFERENCE VALIDATION FAILED for PR #8. Halting.");
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
