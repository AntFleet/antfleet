import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AnatomyBundle } from "@/lib/anatomy";

// Mock the loader so we can drive generateMetadata off a synthetic bundle
// without a DB. fetchHunkPair etc. are never reached by generateMetadata.
vi.mock("@/lib/anatomy", () => ({ loadAnatomyBundle: vi.fn() }));

import { generateMetadata } from "./page";
import { loadAnatomyBundle } from "@/lib/anatomy";

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
