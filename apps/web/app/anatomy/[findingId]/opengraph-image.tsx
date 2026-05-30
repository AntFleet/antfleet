import { ImageResponse } from "next/og";
import { loadAnatomyBundle } from "@/lib/anatomy";
import { redactSecrets } from "@/lib/disagreements";
import { shortenRepoHash, shortenSha } from "@/lib/short-id";

export const runtime = "nodejs";
export const alt = "AntFleet anatomy card showing a unanimous reviewer finding";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type RouteParams = { findingId: string };

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
    const { findingId } = await params;
    const bundle = await loadAnatomyBundle(findingId);
    if (bundle === null) return image(notFoundCard("anatomy"));

    const shaLabel =
      bundle.closureSha !== null ? `closed in ${shortenSha(bundle.closureSha)}` : "open";

    return image(
      <div style={cardStyle}>
        <div style={topBarStyle}>
          <span style={monoMuted(28)}>antfleet[bot]</span>
          <span style={monoMuted(28)}>unanimous</span>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 28 }}>
          <Pill>{bundle.category.toUpperCase()}</Pill>
          <Pill>{bundle.severity.toUpperCase()}</Pill>
        </div>

        <div style={titleStyle}>{redactSecrets(bundle.title)}</div>

        <div style={{ ...monoMuted(28), marginTop: 28 }}>
          repo {shortenRepoHash(bundle.repoHash)} &middot; PR #{bundle.prNumber}
        </div>

        <div style={footerStyle}>
          <span style={monoInk(28)}>antfleet.dev/anatomy/{bundle.findingId}</span>
          <span style={monoInk(28)}>{shaLabel}</span>
        </div>
      </div>,
    );
  } catch {
    return image(notFoundCard("anatomy"));
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
  fontFamily: SANS,
  fontSize: 56,
  fontWeight: 600,
  lineHeight: 1.08,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
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
