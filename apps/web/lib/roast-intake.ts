import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { roastSubmissions, type NewRoastSubmission } from "@/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function countRecentRoastSubmissionsByIp(ipHash: string): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const [row] = await db
    .select({ value: count() })
    .from(roastSubmissions)
    .where(and(gt(roastSubmissions.createdAt, since), eq(roastSubmissions.ipHash, ipHash)));

  return row?.value ?? 0;
}

export async function countRecentRoastSubmissionsByRepo(repoFullName: string): Promise<number> {
  const since = new Date(Date.now() - 7 * DAY_MS);
  const [row] = await db
    .select({ value: count() })
    .from(roastSubmissions)
    .where(
      and(gt(roastSubmissions.createdAt, since), eq(roastSubmissions.repoFullName, repoFullName)),
    );

  return row?.value ?? 0;
}

export async function insertRoastSubmission(submission: NewRoastSubmission): Promise<void> {
  await db.insert(roastSubmissions).values(submission);
}
