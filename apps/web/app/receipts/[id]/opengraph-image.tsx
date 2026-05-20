import { ImageResponse } from "next/og";
import { loadPublicReceiptDetail } from "@/db/queries";
import { toDisplayReceipt } from "@/lib/receipts";

export const runtime = "nodejs";
export const alt = "AntFleet receipt card showing a closed finding and agreement proof";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type RouteParams = { id: string };

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
    const { id } = await params;
    const row = await loadPublicReceiptDetail(id);
    if (row === null) return image(notFoundCard("receipt"));

    const display = toDisplayReceipt(row, new Date());
    const shortId = display.findingId.slice(0, 8);

    return image(
      <div style={cardStyle}>
        <div style={topBarStyle}>
          <span style={monoMuted(28)}>antfleet[bot]</span>
          <span style={monoMuted(28)}>closed in {display.shaLabel ?? "main"}</span>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 28 }}>
          <Pill>{display.severity.toUpperCase()}</Pill>
          <Pill>{display.category.toUpperCase()}</Pill>
        </div>

        <div style={titleStyle}>{display.title}</div>

        <div style={{ ...monoMuted(28), marginTop: 28 }}>
          {display.repoLabel} · {display.prLabel}
        </div>

        <div style={footerStyle}>
          <span style={monoInk(28)}>antfleet.dev/receipts/{shortId}</span>
          <span style={monoInk(28)}>two frontier models · both agreed</span>
        </div>
      </div>,
    );
  } catch {
    return image(notFoundCard("receipt"));
  }
}

function image(element: React.ReactElement): ImageResponse {
  return new ImageResponse(element, { width: WIDTH, height: HEIGHT });
}

function Pill({ children }: { children: React.ReactNode }) {
  return <div style={pillStyle}>{children}</div>;
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
  marginBottom: 32,
};

const titleStyle: React.CSSProperties = {
  color: INK,
  display: "-webkit-box",
  fontFamily: SANS,
  fontSize: 56,
  fontWeight: 600,
  lineHeight: 1.08,
  overflow: "hidden",
  textOverflow: "ellipsis",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 3,
};

const footerStyle: React.CSSProperties = {
  height: 96,
  marginTop: "auto",
  borderTop: `1px solid ${LINE}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const pillStyle: React.CSSProperties = {
  border: `1px solid ${LINE}`,
  borderRadius: 9999,
  color: INK,
  display: "flex",
  fontFamily: MONO,
  fontSize: 24,
  lineHeight: 1,
  padding: "8px 16px",
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
