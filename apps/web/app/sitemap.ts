import type { MetadataRoute } from "next";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db/index";
import { derivedPublicReceiptCondition } from "@/db/public-receipt";
import { findingDisclosure, findingStatus, reviews } from "@/db/schema";
import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { nonCyberTierRepoCondition } from "@/lib/cyber-tier";

const BASE = "https://www.antfleet.dev";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const disclosureGateEnabled = isDisclosureGateEnabled();
  const visibilityCondition = and(
    disclosureGateEnabled ? derivedPublicReceiptCondition : eq(reviews.publicReceipt, true),
    nonCyberTierRepoCondition(),
  );
  const sitemapCondition = and(
    visibilityCondition,
    eq(findingStatus.status, "closed"),
    isNotNull(findingStatus.closureSha),
    // Retracted findings must not be advertised to crawlers — their
    // /anatomy and /receipts pages emit noindex, so keeping them in the
    // sitemap would send Google a contradictory "crawl me" signal.
    isNull(findingStatus.retractedAt),
    // Reader guard (Win 2): shadow single_model findings 404 on /anatomy
    // (they'd resolve the wrong agreed[] index), so never advertise them.
    eq(findingStatus.source, "consensus"),
  );
  const anatomyRows = await (disclosureGateEnabled
    ? db
        .select({
          findingId: findingStatus.findingId,
          closedAt: findingStatus.closureDetectedAt,
        })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .leftJoin(findingDisclosure, eq(findingDisclosure.findingId, findingStatus.findingId))
        .where(sitemapCondition)
        .orderBy(desc(findingStatus.closureDetectedAt))
    : db
        .select({
          findingId: findingStatus.findingId,
          closedAt: findingStatus.closureDetectedAt,
        })
        .from(findingStatus)
        .innerJoin(reviews, eq(findingStatus.reviewId, reviews.reviewId))
        .where(sitemapCondition)
        .orderBy(desc(findingStatus.closureDetectedAt)));

  const staticPages: MetadataRoute.Sitemap = [
    { url: BASE, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/receipts`, changeFrequency: "daily", priority: 0.9 },
    { url: `${BASE}/disagreements`, changeFrequency: "daily", priority: 0.8 },
    { url: `${BASE}/acp`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/agents`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/benchmarks`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/activity`, changeFrequency: "daily", priority: 0.6 },
  ];

  const anatomyEntries: MetadataRoute.Sitemap = anatomyRows.map((row) => ({
    url: `${BASE}/anatomy/${row.findingId}`,
    lastModified: row.closedAt ?? undefined,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  const receiptEntries: MetadataRoute.Sitemap = anatomyRows.map((row) => ({
    url: `${BASE}/receipts/${row.findingId}`,
    lastModified: row.closedAt ?? undefined,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  return [...staticPages, ...anatomyEntries, ...receiptEntries];
}
