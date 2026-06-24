import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ingestSarif,
  type SarifConfirmationResult,
  type SarifIngestDeps,
} from "./sarif-ingest-worker";

const fixtureDir = join(process.cwd(), "test/fixtures/sarif");

describe("ingestSarif", () => {
  it("drops unanimous confirmation false positives with a closure receipt", async () => {
    const updates: unknown[] = [];
    const deps = depsFor({
      updateFinding: vi.fn(async (input) => {
        updates.push(input);
      }),
      confirmation: vi.fn(
        async (): Promise<SarifConfirmationResult> => ({
          verdict: "false_positive",
          reason: "scanner rule does not apply to this bounded snippet",
          modelIds: ["model-a", "model-b"],
        }),
      ),
    });

    const result = await ingestSarif(
      {
        owner: "AntFleet",
        repo: "bench",
        installationId: 1,
        sarifText: readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"),
        sourceKind: "upload",
      },
      deps,
    );

    expect(result.stats).toMatchObject({
      totalClaims: 1,
      falsePositiveCount: 1,
      realCount: 0,
      inconclusiveCount: 0,
    });
    expect(updates[0]).toMatchObject({
      validationVerdict: "false_positive",
      confirmationVerdict: "false_positive",
    });
  });

  it("marks reachable claims real after the reachability gate", async () => {
    const deps = depsFor({
      reachability: vi.fn(async () => ({
        agreed: [],
        downgrades: [],
        rows: [
          {
            index: 0,
            findingId: null,
            outcome: {
              verdict: "reachable" as const,
              entryPoint: null,
              callPath: ["entry", "sink"],
              reason: "reachable from handler",
              modelId: "reachability",
              ms: 1,
              error: null,
            },
          },
        ],
      })),
    });

    const result = await ingestSarif(
      {
        owner: "AntFleet",
        repo: "bench",
        installationId: 1,
        sarifText: readFileSync(join(fixtureDir, "snyk.sarif"), "utf8"),
        sourceKind: "upload",
      },
      deps,
    );

    expect(result.stats.realCount).toBe(1);
  });
});

function depsFor(overrides: Partial<SarifIngestDeps>): SarifIngestDeps {
  return {
    createBatch: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
    insertFindings: vi.fn(async () => undefined),
    updateFinding: vi.fn(async () => undefined),
    finishBatch: vi.fn(async () => undefined),
    reachability: vi.fn(async () => ({
      agreed: [],
      downgrades: [],
      rows: [],
    })),
    enabled: vi.fn(async () => true),
    ...overrides,
  };
}
