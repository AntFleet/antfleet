#!/usr/bin/env tsx
/**
 * Manual scorecard snapshot generator.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate-scorecard.ts --date 2026-05-25
 *   pnpm exec tsx scripts/generate-scorecard.ts --date 2026-05-25 --backfill
 *
 * --date    The week-ending Sunday (YYYY-MM-DD). Must be a valid Sunday.
 * --backfill  Generate all weeks from the earliest review to --date.
 *
 * Requires DATABASE_URL in .env.local or environment.
 */

import "dotenv/config";
import { insertScorecardSnapshot } from "@/db/queries";
import {
  computeScorecardForWeek,
  parseWeekEndingDate,
  weekEndingSunday,
  GENERATOR_VERSION,
} from "@/lib/scorecard";
import { db } from "@/db/index";
import { reviews } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

const args = process.argv.slice(2);
const dateIdx = args.indexOf("--date");
const backfill = args.includes("--backfill");

if (dateIdx === -1 || !args[dateIdx + 1]) {
  console.error("Usage: generate-scorecard.ts --date YYYY-MM-DD [--backfill]");
  process.exit(1);
}

const dateStr = args[dateIdx + 1];
const endDate = parseWeekEndingDate(dateStr);
if (endDate === null) {
  console.error(`Invalid date or not a Sunday: ${dateStr}`);
  process.exit(1);
}
const targetEndDate = endDate;

async function generateOne(weekEndDate: Date): Promise<void> {
  const yyyyMmDd = weekEndDate.toISOString().slice(0, 10);
  console.log(`Generating scorecard for ${yyyyMmDd}...`);
  const payload = await computeScorecardForWeek(weekEndDate);
  const inserted = await insertScorecardSnapshot(yyyyMmDd, payload, GENERATOR_VERSION);
  if (inserted) {
    console.log(
      `  Created: ${payload.sample.reviewsAnalyzed} reviews, ${payload.sample.findingsPosted} findings`,
    );
  } else {
    console.log(`  Already exists, skipped.`);
  }
}

async function main(): Promise<void> {
  if (!backfill) {
    await generateOne(targetEndDate);
    return;
  }

  // Find earliest public-receipt review
  const [earliest] = await db
    .select({ createdAt: reviews.createdAt })
    .from(reviews)
    .where(eq(reviews.publicReceipt, true))
    .orderBy(asc(reviews.createdAt))
    .limit(1);

  if (!earliest) {
    console.log("No public-receipt reviews found. Nothing to backfill.");
    return;
  }

  // Start from the Sunday of the earliest review's week
  const startSunday = weekEndingSunday(earliest.createdAt);
  let currentMs = new Date(startSunday + "T00:00:00Z").getTime();
  const targetEndMs = targetEndDate.getTime();
  let count = 0;

  while (currentMs <= targetEndMs) {
    await generateOne(new Date(currentMs));
    currentMs += 7 * 24 * 60 * 60 * 1000;
    count++;
  }

  console.log(`\nBackfill complete: ${count} weeks processed.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
