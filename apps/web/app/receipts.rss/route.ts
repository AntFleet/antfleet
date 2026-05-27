import { loadPublicReceiptsPage, type PublicReceiptRow } from "@/db/queries";
import { loadCrossRepoReceipts, type CrossRepoReceiptRow } from "@/lib/receipts";
import { renderRssFeed, type RssItem } from "@/lib/rss";

// RSS 2.0 feed for the public receipt corpus. Consumed by monitoring tools
// (Pingdom, BetterStack), RSS readers, and Slack's /feed integration. The
// feed is the same gate as the /receipts page — only reviews with
// public_receipt = true reach this surface, and aggregates count blind
// across all installs but the per-item stream is opt-in only.
// Cross-repo receipts (outgoing PRs that upstream owners merged) are
// interleaved by pubDate with a <category>cross-repo</category> tag so
// subscribers can filter — same trust surface but different artifact
// shape, and the consumer should know which they're looking at.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEED_LIMIT = 50;
const CROSS_REPO_LIMIT = 20;
const SITE_URL = "https://www.antfleet.dev";

export async function GET(): Promise<Response> {
  const [{ recent, lastUpdatedAt }, crossRepo] = await Promise.all([
    loadPublicReceiptsPage({ limit: FEED_LIMIT }),
    loadCrossRepoReceipts(CROSS_REPO_LIMIT),
  ]);

  const sameRepoItems: RssItem[] = recent
    .filter((r): r is PublicReceiptRow & { closedAt: Date } => r.closedAt !== null)
    .map((r) => ({
      title: `${r.category} · ${r.severity} — ${r.title}`,
      link: `${SITE_URL}/receipts/${encodeURIComponent(r.findingId)}`,
      guid: r.findingId,
      pubDate: r.closedAt,
      description: buildDescription(r),
    }));

  const crossRepoItems: RssItem[] = crossRepo.recent.map((r) => ({
    title: `cross-repo · AntFleet → ${r.upstreamOwner}/${r.upstreamRepo} PR #${r.upstreamPrNumber}`,
    link: r.prUrl,
    // guid prefixed with `cross-repo:` so it can never collide with a
    // same-repo finding_id even if both happen to share the same uuid prefix.
    guid: `cross-repo:${r.id}`,
    pubDate: r.resolvedAt,
    description: buildCrossRepoDescription(r),
    category: r.closureMethod === "absorbed_inline" ? "fix-absorbed" : "cross-repo",
  }));

  const items = [...sameRepoItems, ...crossRepoItems].toSorted(
    (a, b) => b.pubDate.getTime() - a.pubDate.getTime(),
  );
  const newestCrossRepo = crossRepo.lastResolvedAt;
  const newestSameRepo = lastUpdatedAt;
  const lastBuildDate =
    newestSameRepo === null
      ? (newestCrossRepo ?? new Date())
      : newestCrossRepo === null
        ? newestSameRepo
        : newestSameRepo > newestCrossRepo
          ? newestSameRepo
          : newestCrossRepo;

  const xml = renderRssFeed({
    title: "AntFleet · Receipts",
    link: `${SITE_URL}/receipts`,
    description:
      "Public, SHA-pinned closure receipts from the AntFleet agreement gate. Every entry is third-party-witnessed on GitHub.",
    selfLink: `${SITE_URL}/receipts.rss`,
    lastBuildDate,
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

function buildCrossRepoDescription(row: CrossRepoReceiptRow): string {
  const verb = row.closureMethod === "absorbed_inline" ? "fix absorbed at" : "merged at";
  return [
    `AntFleet → ${row.upstreamOwner}/${row.upstreamRepo}`,
    `PR #${row.upstreamPrNumber}`,
    `${verb} ${row.resolutionSha.slice(0, 7)}`,
  ].join(" · ");
}
