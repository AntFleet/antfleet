import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatUsd, type RetroEvidence } from "@/lib/retro-render";

// 1200x630 OG card for the static retro receipt page. System fonts only,
// no emoji. Read losses from the same JSON the page reads so the card
// can't drift away from the body copy.

export const runtime = "nodejs";
export const alt =
  "AntFleet retro receipt card — Moonwell MIP-X43 oracle bug, unanimous gate fired";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const WIDTH = 1200;
const HEIGHT = 630;

// Light cream / off-white card per the ralplan: this surface is the
// outward-facing receipt link target, not the dark agent OG cards.
const BG = "#fafaf6";
const INK = "#0a0a0a";
const INK_MUTED = "#5c5c66";
const INK_SUBTLE = "#8a8a94";
const LINE = "#d8d8de";
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const MONO = '"SFMono-Regular", Menlo, Monaco, "Courier New", monospace';

export default function Image(): ImageResponse {
  const evidence = JSON.parse(
    readFileSync(join(process.cwd(), "data/retro/moonwell-mipx43-2026-02.json"), "utf8"),
  ) as RetroEvidence;

  const losses = formatUsd(evidence.lossesUsd);

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
        <span style={{ fontFamily: SANS, fontSize: 40, fontWeight: 700, color: INK }}>
          Moonwell MIP-X43 oracle bug
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
            fontFamily: SANS,
            fontSize: 168,
            fontWeight: 700,
            color: INK,
            letterSpacing: "-0.04em",
            lineHeight: 1,
          }}
        >
          {losses}
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
          Unanimous gate fired — sibling of the cbETH bug, in the same PR.
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
          antfleet.dev/retro/moonwell-mipx43-2026-02
        </span>
        <span style={{ fontFamily: SANS, fontSize: 22, fontWeight: 700, color: INK }}>
          AntFleet
        </span>
      </div>
    </div>,
    { width: WIDTH, height: HEIGHT },
  );
}
