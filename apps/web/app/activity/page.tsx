import type { Metadata } from "next";
import { StatsStrip } from "@/components/StatsStrip";
import { loadFleetActivity } from "@/db/queries";
import { ActivityView, type FleetActivityJson } from "./ActivityView";

// Live ops dashboard for the fleet. This server component fetches the
// initial snapshot (so the first paint is data-rich and SEO-visible);
// the client-side ActivityView takes over on hydration to tick relative
// timestamps every second and poll /api/activity every 60s.
//
// Privacy + headline-honesty: as of the X-attention sprint, aggregate
// counters AND the event stream both gate on reviews.public_receipt =
// true. Before the gate the page showed "receipts closed all-time" >
// the public /receipts list (non-opted-in installs leaked into the
// aggregate); after, the headline equals what /receipts can render.
// Required for tweet-intent + /digest permalinks to stay truthful.
//
// M11: force-dynamic is kept for correctness (fresh counts on every render).
// revalidate is intentionally omitted — Next.js treats force-dynamic as
// revalidate=0 (no-store); adding a revalidate value alongside force-dynamic
// is a no-op at best and a build warning at worst. Per-request freshness is
// the right trade-off here; the client-side poll at 60s reduces the DB cost
// for repeat visitors without a CDN layer needing to cache the HTML.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Activity · AntFleet",
  description:
    "Live ops feed for the AntFleet fleet — recent reviews, agreed findings, closure receipts, and reaction signals.",
};

export default async function ActivityPage() {
  const initial = await loadFleetActivity();
  const initialJson: FleetActivityJson = {
    lastSweepAt: initial.lastSweepAt?.toISOString() ?? null,
    lastReceiptAt: initial.lastReceiptAt?.toISOString() ?? null,
    lastOnboarderAt: initial.lastOnboarderAt?.toISOString() ?? null,
    lastReviewAt: initial.lastReviewAt?.toISOString() ?? null,
    windows: initial.windows,
    events: initial.events.map((e) => ({ ...e, ts: e.ts.toISOString() })),
  };
  const initialNowIso = new Date().toISOString();

  return (
    <>
      <StatsStrip />
      <ActivityView initial={initialJson} initialNowIso={initialNowIso} />
    </>
  );
}
