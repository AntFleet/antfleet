import { ImageResponse } from "next/og";
import { loadScorecardIndex } from "@/db/queries";

export const runtime = "nodejs";
export const alt = "AntFleet AI Scorecard — weekly provider comparison";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0a0a0a";
const INK = "#ffffff";
const INK_MUTED = "#a1a1aa";
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = '"SFMono-Regular", Menlo, Monaco, "Courier New", monospace';

export default async function Image(): Promise<ImageResponse> {
  let cumulativeReviews = 0;
  let cumulativeFindings = 0;

  try {
    const { rows } = await loadScorecardIndex({ limit: 100 });
    for (const row of rows) {
      cumulativeReviews += row.payload.sample.reviewsAnalyzed;
      cumulativeFindings += row.payload.sample.findingsPosted;
    }
  } catch {
    // Fallback to zeros
  }

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        background: BG,
        color: INK,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: SANS,
      }}
    >
      <div style={{ display: "flex", fontSize: 72, fontWeight: 600, marginBottom: 24 }}>
        AntFleet AI Scorecard
      </div>
      <div
        style={{
          display: "flex",
          fontFamily: MONO,
          fontSize: 28,
          color: INK_MUTED,
          marginBottom: 48,
        }}
      >
        {`Weekly provider comparison${cumulativeReviews > 0 ? ` · ${cumulativeReviews} reviews · ${cumulativeFindings} findings` : ""}`}
      </div>
      <div style={{ display: "flex", fontFamily: MONO, fontSize: 24, color: INK_MUTED }}>
        antfleet.dev/scorecard
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}
