import {
  activityWindow,
  loadTopClosuresBetween,
  type ActivityWindow,
  type PublicReceiptRow,
} from "@/db/queries";

export const DIGEST_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_CLOSURES_LIMIT = 3;

export interface WeeklyDigest {
  weekEndingAt: Date;
  since: Date;
  until: Date;
  counts: ActivityWindow;
  topClosures: PublicReceiptRow[];
}

export function parseDigestSlug(raw: string, now: Date = new Date()): Date | null {
  if (!DIGEST_DATE_PATTERN.test(raw)) return null;

  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== raw) return null;
  if (parsed.getTime() > now.getTime()) return null;

  return parsed;
}

export async function loadDigestForWeek(
  weekEndingIsoDate: string,
  now: Date = new Date(),
): Promise<WeeklyDigest | null> {
  const weekEndingAt = parseDigestSlug(weekEndingIsoDate, now);
  if (weekEndingAt === null) return null;

  const since = new Date(weekEndingAt.getTime() - 7 * DAY_MS);

  try {
    const [counts, topClosures] = await Promise.all([
      activityWindow(since, weekEndingAt),
      loadTopClosuresBetween(since, weekEndingAt, TOP_CLOSURES_LIMIT),
    ]);

    return { weekEndingAt, since, until: weekEndingAt, counts, topClosures };
  } catch {
    return null;
  }
}
