import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module before importing the module under test
vi.mock("@/db/index", () => ({
  db: {
    select: vi.fn(),
  },
}));

import { loadAnatomyBundle } from "./anatomy";
import { db } from "@/db/index";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    findingId: "abcd1234-0",
    findingIndex: 0,
    severity: "medium",
    category: "api-contract",
    title: "Missing validation on input",
    status: "closed",
    closureSha: "abc1234567890",
    closureCommentUrl: "https://github.com/example/repo/pull/1#issuecomment-1",
    closedAt: new Date("2026-05-20"),
    createdAt: new Date("2026-05-19"),
    repoHash: "a1b2c3d4e5f6",
    prNumber: 42,
    commitSha: "def7890123456",
    owner: "ExampleOrg",
    repo: "example-repo",
    installationId: 12345,
    providerResponses: {
      perProvider: [
        {
          name: "anthropic",
          ms: 5000,
          error: null,
          output: {
            findings: [
              {
                title: "Missing validation on input",
                category: "api-contract",
                severity: "medium",
                confidence: "high",
                evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20 }],
                reasoning: "The handler accepts unsanitized input.",
                recommendation: "Add validation.",
              },
            ],
          },
        },
        {
          name: "openai",
          ms: 4000,
          error: null,
          output: {
            findings: [
              {
                title: "Input not validated",
                category: "api-contract",
                severity: "medium",
                confidence: "high",
                evidence: [{ path: "src/handler.ts", startLine: 12, endLine: 18 }],
                reasoning: "No validation present.",
                recommendation: "Validate inputs.",
              },
            ],
          },
        },
      ],
    },
    agreementDecision: {
      mode: "unanimous",
      agreed: [
        {
          title: "Missing validation on input",
          category: "api-contract",
          severity: "medium",
          evidence: [{ path: "src/handler.ts", startLine: 10, endLine: 20 }],
        },
      ],
    },
    ...overrides,
  };
}

function mockDbReturns(rows: unknown[]) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadAnatomyBundle", () => {
  it("returns full bundle for a valid finding with both providers", async () => {
    mockDbReturns([makeRow()]);
    const result = await loadAnatomyBundle("abcd1234-0");
    expect(result).not.toBeNull();
    expect(result!.findingId).toBe("abcd1234-0");
    expect(result!.severity).toBe("medium");
    expect(result!.reasoning.anthropic).not.toBeNull();
    expect(result!.reasoning.anthropic!.reasoning).toBe("The handler accepts unsanitized input.");
    expect(result!.reasoning.openai).not.toBeNull();
    expect(result!.reasoning.openai!.reasoning).toBe("No validation present.");
    expect(result!.source.file).toBe("src/handler.ts");
    expect(result!.source.lineStart).toBe(10);
    expect(result!.source.lineEnd).toBe(20);
  });

  it("returns null when finding does not exist", async () => {
    mockDbReturns([]);
    const result = await loadAnatomyBundle("nonexistent-0");
    expect(result).toBeNull();
  });

  it("returns null when public_receipt is false (join fails)", async () => {
    // The inner join with publicReceipt=true produces no rows
    mockDbReturns([]);
    const result = await loadAnatomyBundle("private-finding-0");
    expect(result).toBeNull();
  });

  it("returns bundle with null reasoning when provider_responses is malformed", async () => {
    mockDbReturns([makeRow({ providerResponses: { invalid: true } })]);
    const result = await loadAnatomyBundle("abcd1234-0");
    expect(result).not.toBeNull();
    expect(result!.reasoning.anthropic).toBeNull();
    expect(result!.reasoning.openai).toBeNull();
  });

  it("returns bundle with null reasoning when provider_responses is a string", async () => {
    mockDbReturns([makeRow({ providerResponses: "not json" })]);
    const result = await loadAnatomyBundle("abcd1234-0");
    expect(result).not.toBeNull();
    expect(result!.reasoning.anthropic).toBeNull();
    expect(result!.reasoning.openai).toBeNull();
  });

  it("handles missing agreement_decision gracefully", async () => {
    mockDbReturns([makeRow({ agreementDecision: null })]);
    const result = await loadAnatomyBundle("abcd1234-0");
    expect(result).not.toBeNull();
    expect(result!.source.file).toBe("");
    expect(result!.source.lineStart).toBe(0);
  });

  it("handles nullable owner/repo/installationId", async () => {
    mockDbReturns([makeRow({ owner: null, repo: null, installationId: null })]);
    const result = await loadAnatomyBundle("abcd1234-0");
    expect(result).not.toBeNull();
    expect(result!.source.owner).toBe("");
    expect(result!.source.repo).toBe("");
    expect(result!.source.installationId).toBe(0);
  });
});
