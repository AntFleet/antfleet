import { ImageResponse } from "next/og";
import { loadAgentDetail } from "@/db/queries";
import type { AgentFinding } from "@/db/schema";
import { severityLabel, shortAddress } from "@/lib/agent-findings";

export const runtime = "nodejs";
export const alt = "AntFleet agent investigation card showing public finding count and severity";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

type RouteParams = { address: string };

const WIDTH = 1200;
const HEIGHT = 630;
const BG = "#0a0a0a";
const LINE = "#27272a";
const INK = "#ffffff";
const INK_MUTED = "#a1a1aa";
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = '"SFMono-Regular", Menlo, Monaco, "Courier New", monospace';
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, med: 2, medium: 2, low: 1 };

export default async function Image({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<ImageResponse> {
  try {
    const { address } = await params;
    const agent = await loadAgentDetail(address);
    if (agent === null) return image(notFoundCard("agent"));

    const count = agent.findings.length;
    const highestSeverity = pickHighestSeverity(agent.findings);

    return image(
      <div style={cardStyle}>
        <div style={topBarStyle}>
          <span style={monoMuted(28)}>antfleet[bot]</span>
          <span style={monoMuted(28)}>public investigation</span>
        </div>

        <div style={titleStyle}>{agent.agentName}</div>
        <div style={{ ...monoMuted(28), marginTop: 18 }}>
          {shortAddress(agent.agentTokenAddress)}
        </div>

        <div style={{ display: "flex", alignItems: "center", marginTop: 50 }}>
          <div style={countStyle}>{count}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginLeft: 24 }}>
            <span style={monoMuted(24)}>findings</span>
            <span style={monoMuted(24)}>on file</span>
          </div>
        </div>

        <div style={{ display: "flex", marginTop: 34 }}>
          {highestSeverity === null ? (
            <span style={monoMuted(28)}>no findings yet</span>
          ) : (
            <Pill>{severityLabel(highestSeverity).toUpperCase()}</Pill>
          )}
        </div>

        <div style={footerStyle}>
          <span style={monoInk(28)}>
            antfleet.dev/agents/{shortAddress(agent.agentTokenAddress)}
          </span>
          <span style={monoInk(28)}>trust-layer for the agent fleet</span>
        </div>
      </div>,
    );
  } catch {
    return image(notFoundCard("agent"));
  }
}

function image(element: React.ReactElement): ImageResponse {
  return new ImageResponse(element, { width: WIDTH, height: HEIGHT });
}

function pickHighestSeverity(findings: AgentFinding[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const finding of findings) {
    const rank = SEVERITY_RANK[finding.severity] ?? -1;
    if (rank > bestRank) {
      best = finding.severity;
      bestRank = rank;
    }
  }
  return best;
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
  marginBottom: 42,
};

const titleStyle: React.CSSProperties = {
  color: INK,
  display: "-webkit-box",
  fontFamily: SANS,
  fontSize: 56,
  fontWeight: 600,
  lineHeight: 1.08,
  maxWidth: 900,
  overflow: "hidden",
  textOverflow: "ellipsis",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
};

const countStyle: React.CSSProperties = {
  color: INK,
  fontFamily: SANS,
  fontSize: 120,
  fontVariantNumeric: "tabular-nums",
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
