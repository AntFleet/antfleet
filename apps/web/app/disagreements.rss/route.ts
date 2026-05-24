import {
  loadDisagreementsPage,
  redactSecrets,
  type DisagreementCategory,
  type DisagreementRow,
} from "@/lib/disagreements";
import { renderRssFeed, type RssItem } from "@/lib/rss";
import { shortenRepoHash } from "@/lib/short-id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FEED_LIMIT = 100;
const SITE_URL = "https://www.antfleet.dev";

export async function GET(): Promise<Response> {
  const { rows, lastUpdatedAt } = await loadDisagreementsPage({ limit: FEED_LIMIT });
  const items: RssItem[] = rows.map(disagreementToRssItem);

  const xml = renderRssFeed({
    title: "AntFleet · Disagreements",
    link: `${SITE_URL}/disagreements`,
    description: "Findings where AntFleet's two frontier models didn't agree.",
    selfLink: `${SITE_URL}/disagreements.rss`,
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

function disagreementToRssItem(row: DisagreementRow): RssItem {
  const label = categoryLabel(row.category);
  return {
    title: `[${label}] ${redactSecrets(row.primaryFinding.title)}`,
    link: `${SITE_URL}/disagreements/${encodeURIComponent(row.id)}`,
    guid: `disagreement:${row.id}`,
    pubDate: row.createdAt,
    description: `repo ${shortenRepoHash(row.repoHash)} · PR #${row.prNumber} · ${label}`,
    category: label,
  };
}

function categoryLabel(cat: DisagreementCategory): string {
  switch (cat) {
    case "solo_anthropic":
      return "solo Opus";
    case "solo_openai":
      return "solo GPT-5";
    case "mismatched_classification":
      return "mismatch";
  }
}
