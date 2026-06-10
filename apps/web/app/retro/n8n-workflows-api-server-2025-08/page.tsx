import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderRetroEvidence, type RetroEvidence } from "@/lib/retro-render";

// Static prerender — evidence bundle + caveat inlined at build time.
// No AI coauthor callout: attribution is second-hand via CSA Lab Space, not
// a public Co-Authored-By trailer on the introducing commit.

const evidence = JSON.parse(
  readFileSync(join(process.cwd(), "data/retro/n8n-workflows-api-server-2025-08.json"), "utf8"),
) as RetroEvidence;

const caveatLong = readFileSync(
  join(process.cwd(), "data/retro/n8n-workflows-api-server-2025-08.caveat.md"),
  "utf8",
).trim();

const CAVEAT_SHORT =
  "Blind Virtuals scan: Opus and GPT-5 both caught CVE-2025-55526; $0 inference, second-hand AI attribution.";

const CAVEAT_MEDIUM =
  "A neutral-label scan of n8n-workflows' api_server.py fix made the unanimous gate fire on CVE-2025-55526. GPT-5 graded the Windows backslash traversal high/high; Opus found the same path class plus CORS, FTS5, and leakage issues. Attribution is second-hand CSA Lab Space, not a commit trailer.";

export const metadata: Metadata = {
  title: "Retro: n8n-workflows api_server.py path traversal | AntFleet",
  description: CAVEAT_SHORT,
};

export default function RetroN8nWorkflowsPage() {
  return renderRetroEvidence(evidence, {
    short: CAVEAT_SHORT,
    medium: CAVEAT_MEDIUM,
    long: caveatLong,
  });
}
