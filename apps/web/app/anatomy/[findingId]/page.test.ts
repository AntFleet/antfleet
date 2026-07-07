import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import type { AnatomyBundle } from "@/lib/anatomy";

// Mock the loader so we can drive generateMetadata off a synthetic bundle
// without a DB. fetchHunkPair etc. are never reached by generateMetadata.
vi.mock("@/lib/anatomy", () => ({ loadAnatomyBundle: vi.fn() }));

import AnatomyPage, { generateMetadata } from "./page";
import { loadAnatomyBundle } from "@/lib/anatomy";

// Recursively search a returned React element tree for a
// <script type="application/ld+json"> node. The JSON-LD block is a literal
// JSX element in the non-retracted return, so it's findable without rendering.
function hasJsonLd(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasJsonLd);
  if (node === null || typeof node !== "object") return false;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === "script" && el.props?.["type"] === "application/ld+json") return true;
  return hasJsonLd(el.props?.["children"]);
}

const baseBundle = (over: Partial<AnatomyBundle> = {}): AnatomyBundle => ({
  findingId: "abcd1234-0",
  severity: "high",
  category: "security",
  title: "Example finding",
  repoHash: "a1b2c3d4",
  prNumber: 1,
  status: "open",
  closureSha: null,
  closureCommentUrl: null,
  closedAt: null,
  createdAt: new Date("2026-05-19"),
  retractedAt: null,
  retractionReason: null,
  reasoning: { anthropic: null, openai: null },
  source: {
    owner: "",
    repo: "",
    installationId: 0,
    prSha: "deadbeef",
    file: "",
    lineStart: 0,
    lineEnd: 0,
  },
  ...over,
});

const params = Promise.resolve({ findingId: "abcd1234-0" });
const mockLoad = loadAnatomyBundle as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("anatomy generateMetadata", () => {
  it("indexes a normal finding (no robots noindex, finding details in title)", async () => {
    mockLoad.mockResolvedValue(baseBundle());
    const meta = await generateMetadata({ params });
    expect(meta.robots).toBeUndefined();
    expect(String(meta.title)).toContain("Example finding");
  });

  it("deindexes a retracted finding (robots noindex, no finding details in title)", async () => {
    mockLoad.mockResolvedValue(baseBundle({ retractedAt: new Date("2026-05-30") }));
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(String(meta.title)).toContain("Retracted");
    expect(String(meta.title)).not.toContain("Example finding");
  });
});

describe("anatomy page body — JSON-LD suppression", () => {
  // baseBundle has source.owner="" and closureSha=null, so AnatomyPage skips
  // the GitHub hunk fetch and renders purely from the bundle.
  it("emits JSON-LD structured data for a normal finding", async () => {
    mockLoad.mockResolvedValue(baseBundle());
    const tree = await AnatomyPage({ params });
    expect(hasJsonLd(tree)).toBe(true);
  });

  it("emits NO JSON-LD for a retracted finding (the SEO deindex path)", async () => {
    mockLoad.mockResolvedValue(baseBundle({ retractedAt: new Date("2026-05-30") }));
    const tree = await AnatomyPage({ params });
    expect(hasJsonLd(tree)).toBe(false);
  });

  // Step 0.5 item 8 — retraction notice render seam (e2e dismiss→retraction).
  // Verifies that a retracted finding_status row surfaces as user-visible
  // "This finding has been retracted" text in the anatomy page HTML output,
  // completing the seam: (a) webhook → retractFinding called (covered in
  // route.test.ts) → (b) retractedAt set in DB → (c) anatomy page renders
  // retraction notice and suppresses the original claim text.
  it("renders retraction notice text for a retracted finding (Step 0.5 e2e seam)", async () => {
    mockLoad.mockResolvedValue(
      baseBundle({
        retractedAt: new Date("2026-05-30"),
        retractionReason: "Both models misread a hardened pattern as unsafe.",
      }),
    );
    const tree = await AnatomyPage({ params });
    const html = renderToStaticMarkup(tree as ReactElement);
    expect(html).toContain("This finding has been retracted");
    expect(html).toContain("Both models misread a hardened pattern as unsafe.");
    // Original claim text must be suppressed in the retraction notice.
    expect(html).not.toContain("Example finding");
  });
});
