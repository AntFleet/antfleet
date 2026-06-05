import { ImageResponse } from "next/og";
import { loadScorecardSnapshot } from "@/db/queries";
import { parseWeekEndingDate } from "@/lib/scorecard";

export const runtime = "nodejs";
export const revalidate = 3600;
export const alt = "AntFleet AI Scorecard weekly snapshot";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0a0a0a";
const LINE = "#27272a";
const INK = "#ffffff";
const INK_MUTED = "#a1a1aa";
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = '"SFMono-Regular", Menlo, Monaco, "Courier New", monospace';

type RouteParams = { "yyyy-mm-dd": string };

export default async function Image({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<ImageResponse> {
  const { "yyyy-mm-dd": dateStr } = await params;

  if (parseWeekEndingDate(dateStr) === null) return fallbackImage();

  const snapshot = await loadScorecardSnapshot(dateStr);
  if (snapshot === null) return fallbackImage();

  const p = snapshot.payload;
  const avgA = p.perProvider.anthropic.avgFindingsPerPR.toFixed(1);
  const avgO = p.perProvider.openai.avgFindingsPerPR.toFixed(1);
  const agreementPct = (p.agreement.rate * 100).toFixed(0);

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        background: BG,
        color: INK,
        display: "flex",
        flexDirection: "column",
        padding: "0 64px",
        fontFamily: SANS,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          height: 96,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 28, color: INK_MUTED }}>AI Scorecard</span>
        <span style={{ fontFamily: MONO, fontSize: 28, color: INK_MUTED }}>antfleet.dev</span>
      </div>

      {/* Main content */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 48 }}>
        <div style={{ display: "flex", fontSize: 56, fontWeight: 600, marginBottom: 24 }}>
          {`Week of ${p.weekEnd}`}
        </div>
        <div
          style={{
            display: "flex",
            fontFamily: MONO,
            fontSize: 32,
            color: INK_MUTED,
            marginBottom: 16,
          }}
        >
          {`${p.sample.reviewsAnalyzed} reviews · ${p.sample.findingsPosted} findings`}
        </div>
        <div
          style={{
            display: "flex",
            fontFamily: MONO,
            fontSize: 28,
            color: INK_MUTED,
            marginBottom: 12,
          }}
        >
          {`Anthropic ${avgA}/PR · OpenAI ${avgO}/PR`}
        </div>
        <div style={{ display: "flex", fontFamily: MONO, fontSize: 28, color: INK_MUTED }}>
          {`Agreement ${agreementPct}%`}
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          height: 96,
          marginTop: "auto",
          borderTop: `1px solid ${LINE}`,
          display: "flex",
          alignItems: "center",
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 28, color: INK }}>
          {`antfleet.dev/scorecard/${dateStr}`}
        </span>
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}

function fallbackImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        alignItems: "center",
        background: BG,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      <div style={{ fontFamily: SANS, fontSize: 96, fontWeight: 600, color: INK }}>antfleet</div>
      <div style={{ fontFamily: MONO, fontSize: 28, color: INK_MUTED, marginTop: 16 }}>
        scorecard not found
      </div>
    </div>,
    { width: 1200, height: 630 },
  );
}
