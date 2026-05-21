import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatUsd,
  renderRetroEvidence,
  type AICoauthor,
  type RetroEvidence,
  type RetroSource,
} from "./retro-render";

// Load the real Phase 1 evidence bundle. Resolve relative to this test file
// rather than process.cwd() because vitest may launch from the monorepo root.
// Using fs.readFileSync + JSON.parse keeps the test independent of the
// tsconfig `resolveJsonModule` + import-attribute behavior — Next.js 16
// supports the `with { type: "json" }` syntax but vitest config doesn't
// always plumb it through identically.
const evidencePath = join(
  import.meta.dirname,
  "..",
  "data",
  "retro",
  "moonwell-mipx43-2026-02.json",
);
const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as RetroEvidence;

// Caveat copy is the master copy from the ralplan — hardcoded here so the
// test isn't coupled to the .md file. The page hardcodes the same short and
// medium forms; the long form is read from disk by the page (not the test).
const CAVEAT = {
  short:
    "Unanimous gate fired on a HIGH-severity oracle bug in PR #578. We caught a sibling of the cbETH config that was exploited — not cbETH itself.",
  medium:
    "Both Claude Opus 4.7 and GPT-5 independently flagged a HIGH-severity oracle-feed misconfiguration in PR #578 (MIP-X43). The unanimous gate fired. We did not name cbETH in any finding. The bug we caught — WELL feed wired under xWELL's symbol — is structurally identical to the exploited cbETH config, in the same PR.",
  long: "Long-form caveat sentinel string for renderer pass-through test.",
};

// React's renderToString inserts `<!-- -->` comment nodes between adjacent
// text+expression children, and HTML-encodes apostrophes/quotes/ampersands.
// Normalize both so `.toContain()` checks compare against human-readable
// prose, not the encoded wire format.
function normalize(html: string): string {
  return html
    .replace(/<!--\s*-->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

describe("renderRetroEvidence", () => {
  const html = normalize(renderToString(renderRetroEvidence(evidence, CAVEAT)));

  it("renders the short-form caveat verbatim", () => {
    expect(html).toContain(CAVEAT.short);
  });

  it("renders the medium-form caveat verbatim", () => {
    expect(html).toContain(CAVEAT.medium);
  });

  it("renders the long-form caveat verbatim", () => {
    expect(html).toContain(CAVEAT.long);
  });

  it("renders the outcome letter", () => {
    expect(html).toContain(`Outcome ${evidence.outcome}`);
  });

  it("renders the prompt SHA", () => {
    expect(html).toContain(evidence.promptSha);
  });

  it("renders the introducing PR SHA", () => {
    expect(html).toContain(evidence.introducingPrSha);
  });

  it("renders every anthropic finding title (first 3)", () => {
    const titles = evidence.anthropicRawFindings.slice(0, 3).map((f) => f.title);
    for (const title of titles) {
      expect(html).toContain(title);
    }
  });

  it("renders every openai finding title (first 3)", () => {
    const titles = evidence.openaiRawFindings.slice(0, 3).map((f) => f.title);
    for (const title of titles) {
      expect(html).toContain(title);
    }
  });

  it("renders every unanimous finding title when non-empty", () => {
    if (evidence.unanimousFindings.length === 0) return;
    for (const f of evidence.unanimousFindings) {
      expect(html).toContain(f.title);
    }
  });
});

describe("renderRetroEvidence — AI coauthor callout", () => {
  const aiCoauthor: AICoauthor = {
    author: "Ana Bittencourt",
    coauthor: "Claude Opus 4.6",
    commitSha: "0898069b7e49b60e98cca0903c04f0ef96695ca3",
    commitUrl:
      "https://github.com/moonwell-fi/moonwell-contracts-v2/commit/0898069b7e49b60e98cca0903c04f0ef96695ca3",
  };

  it("renders the callout when aiCoauthor is provided", () => {
    const html = normalize(renderToString(renderRetroEvidence(evidence, CAVEAT, aiCoauthor)));
    expect(html).toContain("AI coauthor");
    expect(html).toContain(aiCoauthor.author);
    expect(html).toContain(aiCoauthor.coauthor);
    expect(html).toContain(aiCoauthor.commitUrl);
  });

  it("omits the callout when aiCoauthor is not provided", () => {
    const html = normalize(renderToString(renderRetroEvidence(evidence, CAVEAT)));
    expect(html).not.toContain("AI coauthor");
    expect(html).not.toContain(aiCoauthor.commitUrl);
  });
});

describe("renderRetroEvidence — sources footer", () => {
  const sources: RetroSource[] = [
    { label: "SlowMist post-mortem", url: "https://example.com/slowmist" },
    { label: "Pashov audit notes", url: "https://example.com/pashov" },
  ];

  it("renders the footer when sources are provided", () => {
    const html = normalize(
      renderToString(renderRetroEvidence(evidence, CAVEAT, undefined, sources)),
    );
    expect(html).toContain("Source post-mortems");
    for (const s of sources) {
      expect(html).toContain(s.label);
      expect(html).toContain(s.url);
    }
  });

  it("omits the footer when sources are undefined", () => {
    const html = normalize(renderToString(renderRetroEvidence(evidence, CAVEAT)));
    expect(html).not.toContain("Source post-mortems");
    expect(html).not.toContain("https://example.com/slowmist");
  });

  it("omits the footer when sources is an empty array", () => {
    const html = normalize(renderToString(renderRetroEvidence(evidence, CAVEAT, undefined, [])));
    expect(html).not.toContain("Source post-mortems");
  });
});

describe("renderRetroEvidence — reproduce-command disclaimer", () => {
  it("renders the 'tool is open-source pending' caption", () => {
    const html = normalize(renderToString(renderRetroEvidence(evidence, CAVEAT)));
    expect(html).toContain("open-source release pending");
  });
});

describe("formatUsd", () => {
  it("formats 1_780_000 as $1.78M", () => {
    expect(formatUsd(1_780_000)).toBe("$1.78M");
  });
});
