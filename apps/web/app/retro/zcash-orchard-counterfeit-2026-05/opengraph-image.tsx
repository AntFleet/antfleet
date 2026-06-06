import { ImageResponse } from "next/og";

// 1200×630 OG card for the Zcash Orchard methodology retro.
// Heroes the four-cell result honestly: PARTIAL / CLASS HIT.

export const runtime = "nodejs";
export const revalidate = 3600;
export const alt =
  "AntFleet retro receipt card — Zcash Orchard counterfeiting bug, blind re-run of the 2021 introducing commit, generalist surfaced adjacent soundness, halo2 specialist wrapper put GPT-5 on the right defect class";
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
          Zcash Orchard counterfeiting bug
        </span>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 28,
        }}
      >
        <div
          style={{
            fontFamily: MONO,
            fontSize: 56,
            fontWeight: 700,
            color: INK,
            letterSpacing: "-0.02em",
            lineHeight: 1.05,
            maxWidth: 1040,
          }}
        >
          Blind re-run of the 2021 introducing commit.
        </div>
        <div
          style={{
            fontFamily: SANS,
            fontSize: 24,
            color: INK_MUTED,
            lineHeight: 1.4,
            maxWidth: 1000,
          }}
        >
          Generalist gate surfaced adjacent soundness flags. A 50-line halo2 specialist wrapper put
          GPT-5 on the missing copy-constraint class — mechanism and fix direction matched. No model
          upgrade, no custom harness.
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            marginTop: 12,
            fontFamily: MONO,
            fontSize: 18,
            color: INK_SUBTLE,
            letterSpacing: "0.02em",
          }}
        >
          <span>generalist · partial / partial</span>
          <span>·</span>
          <span style={{ color: INK }}>specialist · partial / CLASS HIT</span>
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
          antfleet.dev/retro/zcash-orchard-counterfeit-2026-05
        </span>
        <span style={{ fontFamily: SANS, fontSize: 22, fontWeight: 700, color: INK }}>
          AntFleet
        </span>
      </div>
    </div>,
    { width: WIDTH, height: HEIGHT },
  );
}
