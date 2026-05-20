import { ImageResponse } from "next/og";
import { loadRoastDetail } from "@/db/queries";
import type { AgentFinding } from "@/db/schema";
import { severityLabel } from "@/lib/agent-findings";

export const runtime = "nodejs";
export const alt = "AntFleet roast card showing repository review status and findings";
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
const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, med: 2, medium: 2, low: 1 };

export default async function Image({
  params,
}: {
  params: Promise<RouteParams>;
}): Promise<ImageResponse> {
  try {
    const { id } = await params;
    const roast = await loadRoastDetail(id);
    if (roast === null) return image(notFoundCard("roast"));

    const { submission, findings } = roast;
    const status = statusLabel(submission.status, findings.length);
    const highestSeverity = pickHighestSeverity(findings);

    return image(
      <div style={cardStyle}>
        <div style={topBarStyle}>
          <span style={monoMuted(28)}>antfleet[bot]</span>
          <span style={monoMuted(28)}>AntFleet roast</span>
        </div>

        <div style={titleStyle}>{submission.repoFullName ?? "repo redacted"}</div>

        <div style={{ display: "flex", marginTop: 34 }}>
          <Pill muted={submission.status === "queued" || submission.status === "rejected"}>
            <span
              style={
                submission.status === "rejected" ? { textDecoration: "line-through" } : undefined
              }
            >
              {status}
            </span>
          </Pill>
        </div>

        {submission.status === "published" && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 34 }}>
            <span style={monoMuted(28)}>highest severity:</span>
            {highestSeverity === null ? (
              <span style={monoMuted(28)}>none</span>
            ) : (
              <Pill>{severityLabel(highestSeverity).toUpperCase()}</Pill>
            )}
          </div>
        )}

        <div style={footerStyle}>
          <span style={monoInk(28)}>antfleet.dev/roasts/{submission.id.slice(0, 8)}</span>
          <span style={monoInk(28)}>unsolicited code review · anonymous</span>
        </div>
      </div>,
    );
  } catch {
    return image(notFoundCard("roast"));
  }
}

function image(element: React.ReactElement): ImageResponse {
  return new ImageResponse(element, { width: WIDTH, height: HEIGHT });
}

function statusLabel(status: string, findingsCount: number): string {
  if (status === "published") {
    return `published${findingsCount > 0 ? ` · ${findingsCount} findings` : ""}`;
  }
  if (status === "awaiting_approval") return "queued";
  return status;
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

function Pill({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return <div style={{ ...pillStyle, color: muted ? INK_MUTED : INK }}>{children}</div>;
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
  marginBottom: 54,
};

const titleStyle: React.CSSProperties = {
  color: INK,
  display: "-webkit-box",
  fontFamily: SANS,
  fontSize: 56,
  fontWeight: 600,
  lineHeight: 1.08,
  maxWidth: 960,
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
