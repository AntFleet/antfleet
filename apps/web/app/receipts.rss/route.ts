import { loadPublicReceiptsPage, type PublicReceiptRow } from "@/db/queries";
import { renderRssFeed, type RssItem } from "@/lib/rss";

// RSS 2.0 feed for the public receipt corpus. Consumed by monitoring tools
// (Pingdom, BetterStack), RSS readers, and Slack's /feed integration. The
// feed is the same gate as the /receipts page — only reviews with
// public_receipt = true reach this surface, and aggregates count blind
// across all installs but the per-item stream is opt-in only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEED_LIMIT = 50;
const SITE_URL = "https://www.antfleet.dev";

export async function GET(): Promise<Response> {
  const { recent, lastUpdatedAt } = await loadPublicReceiptsPage({ limit: FEED_LIMIT });

  const items: RssItem[] = recent
    .filter((r): r is PublicReceiptRow & { closedAt: Date } => r.closedAt !== null)
    .map((r) => ({
      title: `${r.category} · ${r.severity} — ${r.title}`,
      link: `${SITE_URL}/receipts/${encodeURIComponent(r.findingId)}`,
      guid: r.findingId,
      pubDate: r.closedAt,
      description: buildDescription(r),
    }));

  const xml = renderRssFeed({
    title: "AntFleet · Receipts",
    link: `${SITE_URL}/receipts`,
    description:
      "Public, SHA-pinned closure receipts from the AntFleet agreement gate. Every entry is third-party-witnessed on GitHub.",
    selfLink: `${SITE_URL}/receipts.rss`,
    lastBuildDate: lastUpdatedAt ?? new Date(),
    items,
  });

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}

function buildDescription(row: PublicReceiptRow): string {
  const parts: string[] = [];
  parts.push(`repo ${row.repoHash.slice(0, 8)}`);
  parts.push(`PR #${row.prNumber}`);
  if (row.closureSha !== null) {
    parts.push(`closed in ${row.closureSha.slice(0, 7)}`);
  }
  return parts.join(" · ");
}
