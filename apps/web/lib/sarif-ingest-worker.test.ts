import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ingestSarif,
  type SarifConfirmationResult,
  type SarifIngestDeps,
} from "./sarif-ingest-worker";
import { MAX_SARIF_FINDINGS_PER_BATCH, SarifLimitError } from "./sarif-types";

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

  it("marks reachable claims real only after verified patch verification", async () => {
    const patchAndVerify = vi.fn(async () => "verified" as const);
    const deps = depsFor({
      reachability: reachable,
      patchAndVerify,
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

  it("uses the installation-resolved clone URL and SARIF revision for patch verification", async () => {
    const patchAndVerify = vi.fn(async () => "verified" as const);
    const deps = depsFor({
      reachability: reachable,
      resolveCloneUrl: vi.fn(async () => "https://github.com/AntFleet/bench.git"),
      patchAndVerify,
    });

    await ingestSarif(
      {
        owner: "AntFleet",
        repo: "bench",
        installationId: 1,
        sarifText: readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"),
        sourceKind: "upload",
        ...({
          repoUrl: "https://attacker.test/repo.git",
          sha: "ffffffffffffffffffffffffffffffffffffffff",
        } as Record<string, unknown>),
      },
      deps,
    );

    expect(deps.resolveCloneUrl).toHaveBeenCalledWith({
      installationId: 1,
      owner: "AntFleet",
      repo: "bench",
    });
    expect(patchAndVerify).toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://github.com/AntFleet/bench.git",
        sha: "1111111111111111111111111111111111111111",
      }),
    );
  });

  it.each([
    ["null", async () => null],
    ["regressed", async () => "regressed" as const],
    [
      "threw",
      async () => {
        throw new Error("verifier unavailable");
      },
    ],
  ])(
    "keeps reachable claims inconclusive when patch verifier %s",
    async (_label, patchAndVerify) => {
      const updates: Array<{ validationVerdict?: string; patchVerifyVerdict?: string | null }> = [];
      const deps = depsFor({
        reachability: reachable,
        patchAndVerify: vi.fn(patchAndVerify),
        updateFinding: vi.fn(async (input) => {
          updates.push(input);
        }),
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

      expect(result.stats).toMatchObject({ realCount: 0, inconclusiveCount: 1, errorCount: 0 });
      expect(updates[0]).toMatchObject({ validationVerdict: "inconclusive" });
    },
  );

  it("keeps reachable claims inconclusive when patch verifier is absent", async () => {
    const deps = depsFor({ reachability: reachable });

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

    expect(result.stats).toMatchObject({ realCount: 0, inconclusiveCount: 1, errorCount: 0 });
  });

  it("rejects oversized batches before creating DB rows", async () => {
    const deps = depsFor({});
    await expect(
      ingestSarif(
        {
          owner: "AntFleet",
          repo: "bench",
          installationId: 1,
          sarifText: JSON.stringify(largeSarif(MAX_SARIF_FINDINGS_PER_BATCH + 1)),
          sourceKind: "upload",
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(SarifLimitError);
    expect(deps.createBatch).not.toHaveBeenCalled();
  });
});

const reachable = vi.fn(async () => ({
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
}));

function depsFor(overrides: Partial<SarifIngestDeps>): SarifIngestDeps {
  return {
    createBatch: vi.fn(async () => "00000000-0000-4000-8000-000000000001"),
    insertFindings: vi.fn(async () => undefined),
    updateFinding: vi.fn(async () => undefined),
    finishBatch: vi.fn(async () => undefined),
    resolveCloneUrl: vi.fn(async () => "https://github.com/AntFleet/bench.git"),
    reachability: vi.fn(async () => ({
      agreed: [],
      downgrades: [],
      rows: [],
    })),
    enabled: vi.fn(async () => true),
    ...overrides,
  };
}

function largeSarif(resultCount: number): Record<string, unknown> {
  const remaining = Array.from({ length: resultCount }, (_value, index) => index);
  const runs = [];
  while (remaining.length > 0) {
    const indexes = remaining.splice(0, 5000);
    runs.push({
      tool: { driver: { name: "CodeQL", rules: [] } },
      results: indexes.map((index) => ({
        ruleId: "rule",
        message: { text: `message ${index}` },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: `src/${index}.ts` },
              region: { startLine: 1, snippet: { text: "const x = 1;" } },
            },
          },
        ],
      })),
    });
  }
  return {
    version: "2.1.0",
    runs,
  };
}
