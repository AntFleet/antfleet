import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RetroEvidence } from "@/lib/retro-render";

// 1200x630 OG card for the n8n-workflows retro receipt page.
// No dollar loss for this case — hero shows CVE ID + severity instead.

export const runtime = "nodejs";
export const revalidate = 3600;
export const alt =
  "AntFleet retro receipt card — n8n-workflows CVE-2025-55526 api_server.py path traversal, unanimous gate fired";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const WIDTH = 1200;
const HEIGHT = 630;

const BG = "#fafaf6";
const INK = "#0a0a0a";
const INK_MUTED = "#5c5c66";
const INK_SUBTLE = "#8a8a94";
const LINE = "#d8d8de";
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = '"SFMono-Regular", Menlo, Monaco, "Courier New", monospace';

export default function Image(): ImageResponse {
  // Read evidence just to keep the card in sync with page data.
  JSON.parse(
    readFileSync(join(process.cwd(), "data/retro/n8n-workflows-api-server-2025-08.json"), "utf8"),
  ) as RetroEvidence;

  return new ImageResponse(
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        background: BG,
        color: INK,
        display: "flex",
        flexDirection: "column",
        padding: "0 64px",
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          height: 96,
          display: "flex",
          alignItems: "center",
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <span style={{ fontFamily: SANS, fontSize: 34, fontWeight: 700, color: INK }}>
          n8n-workflows api_server.py path traversal
        </span>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 24,
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 72,
            fontWeight: 700,
            color: INK,
            letterSpacing: "-0.02em",
            lineHeight: 1,
          }}
        >
          CVE-2025-55526
        </div>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 22,
            color: INK_MUTED,
            letterSpacing: "0.02em",
          }}
        >
          HIGH · Windows path traversal · Zie619/n8n-workflows
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 26,
            color: INK_MUTED,
            lineHeight: 1.3,
            maxWidth: 980,
          }}
        >
          Unanimous gate fired — both Claude Opus 4.7 and GPT-5 flagged the neutral-label commit.
          GPT-5 named the backslash bypass.
        </div>
      </div>

      <div
        style={{
          height: 96,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${LINE}`,
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: 18, color: INK_SUBTLE }}>
          antfleet.dev/retro/n8n-workflows-api-server-2025-08
        </span>
        <span style={{ fontFamily: SANS, fontSize: 22, fontWeight: 700, color: INK }}>
          AntFleet
        </span>
      </div>
    </div>,
    { width: WIDTH, height: HEIGHT },
  );
}
