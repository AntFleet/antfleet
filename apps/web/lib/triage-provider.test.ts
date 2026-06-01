import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChangedFile } from "./github-files";

// Mock the Anthropic SDK so triage never touches the network. The default
// export is the client class; we only exercise `messages.create`.
const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

import { triagePR, TRIAGE_MODEL } from "./triage-provider";

function mkFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: "README.md",
    contents: "# docs",
    status: "modified",
    sha: "sha-1",
    patch: null,
    ...overrides,
  };
}

// Shape of a non-streaming Anthropic message with a single text block.
function textResponse(obj: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

beforeEach(() => {
  createMock.mockReset();
});

describe("triagePR", () => {
  it("returns worthEscalating: false for a docs-only file list", async () => {
    createMock.mockResolvedValue(
      textResponse({ worthEscalating: false, reason: "docs only" }),
    );
    const result = await triagePR({ files: [mkFile()] });
    expect(result.worthEscalating).toBe(false);
    expect(result.reason).toBe("docs only");
    expect(result.error).toBeNull();
    expect(result.modelId).toBe(TRIAGE_MODEL);
    expect(typeof result.ms).toBe("number");
  });

  it("returns worthEscalating: true for a file list containing .ts source changes", async () => {
    createMock.mockResolvedValue(
      textResponse({ worthEscalating: true, reason: "logic change in source" }),
    );
    const result = await triagePR({
      files: [mkFile({ filename: "apps/web/lib/foo.ts", contents: "export function f(){return 1}" })],
    });
    expect(result.worthEscalating).toBe(true);
    expect(result.error).toBeNull();
  });

  it("fails open (worthEscalating: true, error non-null) when the API call throws", async () => {
    createMock.mockRejectedValue(new Error("anthropic 500 boom"));
    const result = await triagePR({
      files: [mkFile({ filename: "apps/web/lib/foo.ts", contents: "x" })],
    });
    expect(result.worthEscalating).toBe(true);
    expect(result.error).toContain("boom");
    expect(result.reason).toMatch(/failing open/u);
    expect(result.modelId).toBe(TRIAGE_MODEL);
  });

  it("fails open when the response is not parseable JSON", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "not json at all" }] });
    const result = await triagePR({ files: [mkFile()] });
    expect(result.worthEscalating).toBe(true);
    expect(result.error).not.toBeNull();
  });

  it("fails open when a skip arrives with no reason", async () => {
    // A structurally-valid but unreasoned skip must not silently drop a review.
    createMock.mockResolvedValue(textResponse({ worthEscalating: false, reason: "" }));
    const result = await triagePR({ files: [mkFile()] });
    expect(result.worthEscalating).toBe(true);
    expect(result.error).not.toBeNull();
  });
});
