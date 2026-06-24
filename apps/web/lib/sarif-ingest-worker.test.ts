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
        tokenUse: tokenUse(),
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
        tokenUse: tokenUse(),
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
        tokenUse: tokenUse(),
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
          tokenUse: tokenUse(),
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
        tokenUse: tokenUse(),
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
          tokenUse: tokenUse(),
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(SarifLimitError);
    expect(deps.createBatch).not.toHaveBeenCalled();
  });

  it("requires a consumed token use before parsing SARIF", async () => {
    const deps = depsFor({});

    await expect(
      ingestSarif(
        {
          owner: "AntFleet",
          repo: "bench",
          installationId: 1,
          sarifText: readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"),
          sourceKind: "upload",
          tokenUse: null,
        },
        deps,
      ),
    ).rejects.toThrow(/token use must be consumed before parsing/u);
    expect(deps.createBatch).not.toHaveBeenCalled();
    expect(deps.resolveCloneUrl).not.toHaveBeenCalled();
  });

  it("fires codeScanningPush only when the flag is on AND a finding promoted to real", async () => {
    const previous = process.env["ANTFLEET_CODESCANNING_PUSH"];
    process.env["ANTFLEET_CODESCANNING_PUSH"] = "true";
    try {
      const codeScanningPush = vi.fn(async () => ({
        kind: "accepted" as const,
        id: "analysis-1",
        url: "https://api.github.com/x/analysis-1",
      }));
      const deps = depsFor({
        reachability: reachable,
        patchAndVerify: vi.fn(async () => "verified" as const),
        codeScanningPush,
      });
      await ingestSarif(
        {
          owner: "AntFleet",
          repo: "bench",
          installationId: 1,
          sarifText: readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"),
          sourceKind: "upload",
          tokenUse: tokenUse(),
        },
        deps,
      );
      expect(codeScanningPush).toHaveBeenCalledWith({
        owner: "AntFleet",
        repo: "bench",
        commitSha: "1111111111111111111111111111111111111111",
      });
    } finally {
      if (previous === undefined) delete process.env["ANTFLEET_CODESCANNING_PUSH"];
      else process.env["ANTFLEET_CODESCANNING_PUSH"] = previous;
    }
  });

  it("does NOT call codeScanningPush when the flag is off", async () => {
    const previous = process.env["ANTFLEET_CODESCANNING_PUSH"];
    delete process.env["ANTFLEET_CODESCANNING_PUSH"];
    try {
      const codeScanningPush = vi.fn();
      const deps = depsFor({
        reachability: reachable,
        patchAndVerify: vi.fn(async () => "verified" as const),
        codeScanningPush,
      });
      await ingestSarif(
        {
          owner: "AntFleet",
          repo: "bench",
          installationId: 1,
          sarifText: readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"),
          sourceKind: "upload",
          tokenUse: tokenUse(),
        },
        deps,
      );
      expect(codeScanningPush).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env["ANTFLEET_CODESCANNING_PUSH"] = previous;
    }
  });

  it("does NOT call codeScanningPush when no findings promoted to real", async () => {
    const previous = process.env["ANTFLEET_CODESCANNING_PUSH"];
    process.env["ANTFLEET_CODESCANNING_PUSH"] = "true";
    try {
      const codeScanningPush = vi.fn();
      const deps = depsFor({
        reachability: vi.fn(async () => ({ agreed: [], downgrades: [], rows: [] })),
        codeScanningPush,
      });
      await ingestSarif(
        {
          owner: "AntFleet",
          repo: "bench",
          installationId: 1,
          sarifText: readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"),
          sourceKind: "upload",
          tokenUse: tokenUse(),
        },
        deps,
      );
      expect(codeScanningPush).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env["ANTFLEET_CODESCANNING_PUSH"];
      else process.env["ANTFLEET_CODESCANNING_PUSH"] = previous;
    }
  });

  it("does not fail the worker when codeScanningPush throws", async () => {
    const previous = process.env["ANTFLEET_CODESCANNING_PUSH"];
    process.env["ANTFLEET_CODESCANNING_PUSH"] = "true";
    try {
      const codeScanningPush = vi.fn(async () => {
        throw new Error("network down");
      });
      const deps = depsFor({
        reachability: reachable,
        patchAndVerify: vi.fn(async () => "verified" as const),
        codeScanningPush,
      });
      const result = await ingestSarif(
        {
          owner: "AntFleet",
          repo: "bench",
          installationId: 1,
          sarifText: readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"),
          sourceKind: "upload",
          tokenUse: tokenUse(),
        },
        deps,
      );
      expect(result.stats.realCount).toBe(1);
      expect(codeScanningPush).toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env["ANTFLEET_CODESCANNING_PUSH"];
      else process.env["ANTFLEET_CODESCANNING_PUSH"] = previous;
    }
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

function tokenUse() {
  return {
    jti: "00000000-0000-4000-8000-000000000123",
    keyId: "sarif-hmac-v1",
    installationId: 1,
    repo: "AntFleet/bench",
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
