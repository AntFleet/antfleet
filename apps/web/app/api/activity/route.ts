import { NextResponse } from "next/server";
import { loadFleetActivity } from "@/db/queries";

// JSON endpoint backing the /activity page's background polling. The page
// is a server component that renders an initial paint from the same query;
// once the client mounts, it polls this endpoint on a 60s interval to
// refresh counters + the event stream in place. Same privacy gate as the
// HTML page (aggregates are repo-blind; event-stream rows are
// public_receipt-only) since both call loadFleetActivity.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const data = await loadFleetActivity();
  return NextResponse.json(data, {
    headers: {
      // Don't let the browser or any CDN cache this. The whole point of
      // polling is to see fresh state every interval — a cached response
      // defeats the live-feel and stales the LIVE pill.
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
