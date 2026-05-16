import type { PublicReceiptRow } from "@/db/queries";

// Pure view-model for the public /receipts page. Lives apart from the DB
// query so the adapter (privacy labels + relative time) can be unit-tested
// without a database round-trip. The receipt URL is preserved as-is — it
// IS the receipt artifact per §18.2 and §15; without the link, the page
// is just numbers we could have made up.
export type DisplayReceipt = {
  findingId: string;
  severity: string;
  category: string;
  title: string;
  repoLabel: string;
  prLabel: string;
  shaLabel: string | null;
  relativeClosedAt: string | null;
  receiptUrl: string | null;
};

const REPO_LABEL_LEN = 8;
const SHA_LABEL_LEN = 7;

export function toDisplayReceipt(row: PublicReceiptRow, now: Date): DisplayReceipt {
  return {
    findingId: row.findingId,
    severity: row.severity,
    category: row.category,
    title: row.title,
    repoLabel: `repo ${row.repoHash.slice(0, REPO_LABEL_LEN)}`,
    prLabel: `PR #${row.prNumber}`,
    shaLabel: row.closureSha === null ? null : row.closureSha.slice(0, SHA_LABEL_LEN),
    relativeClosedAt: row.closedAt === null ? null : formatRelativeTime(now, row.closedAt),
    receiptUrl: row.closureCommentUrl,
  };
}

// "just now" / "3 minutes ago" / "5 hours ago" / "2 days ago" / "3 weeks ago"
// / "4 months ago" / "1 year ago". No fractions; rounds toward zero. Future
// dates are clamped to "just now" — the receipts page shows closures that
// already happened, so a future stamp is data-integrity noise we shouldn't
// surface to the public page.
export function formatRelativeTime(now: Date, then: Date): string {
  const deltaMs = now.getTime() - then.getTime();
  if (deltaMs < 0) return "just now";

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  if (deltaMs < MINUTE) return "just now";
  if (deltaMs < HOUR) return plural(Math.floor(deltaMs / MINUTE), "minute");
  if (deltaMs < DAY) return plural(Math.floor(deltaMs / HOUR), "hour");
  if (deltaMs < WEEK) return plural(Math.floor(deltaMs / DAY), "day");
  if (deltaMs < MONTH) return plural(Math.floor(deltaMs / WEEK), "week");
  if (deltaMs < YEAR) return plural(Math.floor(deltaMs / MONTH), "month");
  return plural(Math.floor(deltaMs / YEAR), "year");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
