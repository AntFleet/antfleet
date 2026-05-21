import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderRetroEvidence, type AICoauthor, type RetroEvidence } from "@/lib/retro-render";

// Static prerender — no force-dynamic, no revalidate. The page is a constant
// at build time; the Phase 1 evidence bundle + the long-form caveat file are
// inlined into the deploy artifact.
//
// Future retro cases (different incident) ship as sibling routes under
// /retro/<case-id>; they all reuse @/lib/retro-render.

const evidence = JSON.parse(
  readFileSync(join(process.cwd(), "data/retro/moonwell-mipx43-2026-02.json"), "utf8"),
) as RetroEvidence;

const caveatLong = readFileSync(
  join(process.cwd(), "data/retro/moonwell-mipx43-2026-02.caveat.md"),
  "utf8",
).trim();

// Short + medium forms are inline here (≤140 / ~280 chars; pulled from the
// ralplan master copy). Updating these in the future means editing this file.
const CAVEAT_SHORT =
  "Unanimous gate fired on a HIGH-severity oracle bug in PR #578. We caught a sibling of the cbETH config that was exploited — not cbETH itself.";

const CAVEAT_MEDIUM =
  "Both Claude Opus 4.7 and GPT-5 independently flagged a HIGH-severity oracle-feed misconfiguration in PR #578 (MIP-X43). The unanimous gate fired. We did not name cbETH in any finding. The bug we caught — WELL feed wired under xWELL's symbol — is structurally identical to the exploited cbETH config, in the same PR.";

// AI-coauthor attribution. Verified 2026-05-21 via
// `gh api repos/moonwell-fi/moonwell-contracts-v2/commits/0898069...` —
// the commit message contains the `Co-Authored-By: Claude Opus 4.6` trailer
// verbatim. This data is editorial context (which agent coauthored the
// introducing commit) and is intentionally NOT inside the Phase 1 evidence
// bundle (which captures scanner output verbatim, nothing else).
const AI_COAUTHOR: AICoauthor = {
  author: "Ana Bittencourt",
  coauthor: "Claude Opus 4.6",
  commitSha: "0898069b7e49b60e98cca0903c04f0ef96695ca3",
  commitUrl:
    "https://github.com/moonwell-fi/moonwell-contracts-v2/commit/0898069b7e49b60e98cca0903c04f0ef96695ca3",
};

export const metadata: Metadata = {
  title: "Retro: Moonwell MIP-X43 oracle bug | AntFleet",
  description: CAVEAT_SHORT,
};

export default function RetroMoonwellPage() {
  return renderRetroEvidence(
    evidence,
    { short: CAVEAT_SHORT, medium: CAVEAT_MEDIUM, long: caveatLong },
    AI_COAUTHOR,
  );
}
