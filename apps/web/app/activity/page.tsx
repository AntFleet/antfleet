import type { Metadata } from "next";
import { loadFleetActivity } from "@/db/queries";
import { ActivityView, type FleetActivityJson } from "./ActivityView";

// Live ops dashboard for the fleet. This server component fetches the
// initial snapshot (so the first paint is data-rich and SEO-visible);
// the client-side ActivityView takes over on hydration to tick relative
// timestamps every second and poll /api/activity every 60s.
//
// Privacy: aggregate counters are repo-blind so they include every
// install (no leak). Event stream gates on reviews.public_receipt = true
// so non-opted-in installs never surface as visible rows even though
// their counts contribute to the aggregates.
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

  return <ActivityView initial={initialJson} initialNowIso={initialNowIso} />;
}
