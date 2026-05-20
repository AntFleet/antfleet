import { ImageResponse } from "next/og";
import { loadDigestForWeek } from "@/lib/digest";

export const runtime = "nodejs";
export const alt = "AntFleet weekly digest card showing public activity counters";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type RouteParams = { "yyyy-mm-dd": string };

const WIDTH = 1200;
const HEIGHT = 630;
const BG = "#0a0a0a";
const LINE = "#27272a";
const INK = "#ffffff";
const INK_MUTED = "#a1a1aa";
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = '"SFMono-Regular", Menlo, Monaco, "Courier New", monospace';

export default async function Image({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<ImageResponse> {
  try {
    const { "yyyy-mm-dd": weekEndingIso } = await params;
    const digest = await loadDigestForWeek(weekEndingIso);
    if (digest === null) return image(notFoundCard());

    const counters = [
      ["reviewsRun", digest.counts.reviewsRun],
      ["findingsAgreed", digest.counts.findingsAgreed],
      ["receiptsClosed", digest.counts.receiptsClosed],
      ["reactionsObserved", digest.counts.reactionsObserved],
    ] as const;
    const topTitle = digest.topClosures[0]?.title;

    return image(
      <div style={cardStyle}>
        <div style={topBarStyle}>
          <span style={monoMuted(28)}>antfleet[bot]</span>
          <span style={monoMuted(28)}>AntFleet weekly digest</span>
        </div>

        <div style={titleStyle}>Week of {weekEndingIso}</div>

        <div style={counterRowStyle}>
          {counters.map(([label, value]) => (
            <div key={label} style={counterStyle}>
              <div style={counterNumberStyle}>{value.toLocaleString()}</div>
              <div style={monoMuted(24)}>{label}</div>
            </div>
          ))}
        </div>

        {topTitle !== undefined && (
          <div style={{ ...monoMuted(24), marginTop: 34 }}>top: {truncate(topTitle, 60)}</div>
        )}

        <div style={footerStyle}>
          <span style={monoInk(28)}>antfleet.dev/digest/{weekEndingIso}</span>
          <span style={monoInk(28)}>public-receipt installs only</span>
        </div>
      </div>,
    );
  } catch {
    return image(notFoundCard());
  }
}

function image(element: React.ReactElement): ImageResponse {
  return new ImageResponse(element, { width: WIDTH, height: HEIGHT });
}

function notFoundCard(): React.ReactElement {
  return (
    <div style={notFoundStyle}>
      <div style={{ color: INK, fontFamily: SANS, fontSize: 96, fontWeight: 600 }}>antfleet</div>
      <div style={{ ...monoMuted(28), marginTop: 16 }}>digest not found</div>
    </div>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

const cardStyle: React.CSSProperties = {
  width: WIDTH,
  height: HEIGHT,
  background: BG,
  color: INK,
  display: "flex",
  flexDirection: "column",
  padding: "0 64px",
  fontFamily: SANS,
};

const topBarStyle: React.CSSProperties = {
  height: 96,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  borderBottom: `1px solid ${LINE}`,
  marginBottom: 34,
};

const titleStyle: React.CSSProperties = {
  color: INK,
  fontFamily: SANS,
  fontSize: 56,
  fontWeight: 600,
  lineHeight: 1.05,
};

const counterRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 28,
  marginTop: 42,
};

const counterStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: 246,
};

const counterNumberStyle: React.CSSProperties = {
  color: INK,
  fontFamily: MONO,
  fontSize: 96,
  fontWeight: 600,
  lineHeight: 0.95,
};

const footerStyle: React.CSSProperties = {
  height: 96,
  marginTop: "auto",
  borderTop: `1px solid ${LINE}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const notFoundStyle: React.CSSProperties = {
  width: WIDTH,
  height: HEIGHT,
  alignItems: "center",
  background: BG,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
};

function monoMuted(fontSize: number): React.CSSProperties {
  return { color: INK_MUTED, fontFamily: MONO, fontSize, lineHeight: 1.2 };
}

function monoInk(fontSize: number): React.CSSProperties {
  return { color: INK, fontFamily: MONO, fontSize, lineHeight: 1.2 };
}
