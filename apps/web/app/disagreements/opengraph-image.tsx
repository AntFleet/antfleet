import { ImageResponse } from "next/og";
import { loadDisagreementsPage } from "@/lib/disagreements";

export const runtime = "nodejs";
export const revalidate = 60;
export const alt = "AntFleet disagreement archive card showing filtered reviewer disagreements";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const WIDTH = 1200;
const HEIGHT = 630;
const BG = "#0a0a0a";
const LINE = "#27272a";
const INK = "#ffffff";
const INK_MUTED = "#a1a1aa";
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = '"SFMono-Regular", Menlo, Monaco, "Courier New", monospace';

export default async function Image(): Promise<ImageResponse> {
  try {
    const { totalCount } = await loadDisagreementsPage({ limit: 1 });

    return image(
      <div style={cardStyle}>
        <div style={topBarStyle}>
          <span style={monoMuted(28)}>antfleet[bot]</span>
          <span style={monoMuted(28)}>disagreement archive</span>
        </div>

        <div style={countStyle}>{totalCount.toLocaleString()}</div>
        <div style={{ ...monoMuted(32), marginTop: 18 }}>We publish what we don&apos;t post</div>

        <div style={footerStyle}>
          <span style={monoInk(28)}>antfleet.dev/disagreements</span>
          <span style={monoInk(28)}>two frontier models · they disagreed</span>
        </div>
      </div>,
    );
  } catch {
    return image(notFoundCard("disagreement archive"));
  }
}

function image(element: React.ReactElement): ImageResponse {
  return new ImageResponse(element, { width: WIDTH, height: HEIGHT });
}

function notFoundCard(entity: string): React.ReactElement {
  return (
    <div style={notFoundStyle}>
      <div style={{ fontFamily: SANS, fontSize: 96, fontWeight: 600, color: INK }}>antfleet</div>
      <div style={{ ...monoMuted(28), marginTop: 16 }}>{entity} not found</div>
    </div>
  );
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
  marginBottom: 64,
};

const countStyle: React.CSSProperties = {
  color: INK,
  fontFamily: MONO,
  fontSize: 128,
  fontWeight: 600,
  lineHeight: 1,
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
