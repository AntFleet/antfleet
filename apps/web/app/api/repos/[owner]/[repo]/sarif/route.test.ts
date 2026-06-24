import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSarifIngest, type SarifRouteDeps } from "./route";
import { MAX_SARIF_BYTES } from "@/lib/sarif-types";

const ctx = { params: Promise.resolve({ owner: "AntFleet", repo: "bench" }) };

describe("/api/repos/[owner]/[repo]/sarif", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects anonymous requests before ingesting", async () => {
    const deps = depsFor({ authenticate: () => "missing" });
    const res = await handleSarifIngest(req({ sarif: minimalSarif() }), ctx, deps);

    expect(res.status).toBe(401);
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("rejects an authenticated installation token for a different repo", async () => {
    const deps = depsFor({
      authenticate: () => ({
        installationId: 123,
        owner: "Other",
        repo: "bench",
        tokenUse: {
          jti: "00000000-0000-4000-8000-000000000123",
          keyId: "sarif-hmac-v1",
          installationId: 123,
          repo: "Other/bench",
        },
      }),
    });
    const res = await handleSarifIngest(req({ sarif: minimalSarif() }), ctx, deps);

    expect(res.status).toBe(403);
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("checks the feature flag before reading malformed JSON", async () => {
    const deps = depsFor({ enabled: vi.fn(async () => false) });
    const res = await handleSarifIngest(rawReq("not-json"), ctx, deps);

    expect(res.status).toBe(403);
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("rejects URL ingest without fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const deps = depsFor();
    const res = await handleSarifIngest(
      req({ url: "https://example.test/results.sarif" }),
      ctx,
      deps,
    );

    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON bodies from Content-Length before reading", async () => {
    const deps = depsFor();
    const res = await handleSarifIngest(
      rawReq("{}", { "content-length": String(MAX_SARIF_BYTES + 1) }),
      ctx,
      deps,
    );

    expect(res.status).toBe(413);
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("uses the authenticated installation id instead of any body field", async () => {
    const deps = depsFor();
    const res = await handleSarifIngest(
      req({
        installationId: 999,
        sarif: minimalSarif(),
        repoUrl: "https://attacker.test/repo.git",
        sha: "abc1234",
      }),
      ctx,
      deps,
    );

    expect(res.status).toBe(202);
    expect(deps.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 123,
        owner: "AntFleet",
        repo: "bench",
        sourceKind: "upload",
        sourceUrl: null,
        tokenUse: expect.objectContaining({ jti: "00000000-0000-4000-8000-000000000123" }),
      }),
    );
    expect(deps.ingest).not.toHaveBeenCalledWith(
      expect.objectContaining({
        repoUrl: "https://attacker.test/repo.git",
      }),
    );
    expect(deps.ingest).not.toHaveBeenCalledWith(expect.objectContaining({ sha: "abc1234" }));
  });

  it("consumes a concurrent replay before SARIF parse or clone resolution", async () => {
    const used = new Set<string>();
    const parseSarif = vi.fn();
    const resolveCloneUrl = vi.fn(async () => "https://github.com/AntFleet/bench.git");
    const ingest = vi.fn(async (input) => {
      parseSarif(input.sarifText);
      await resolveCloneUrl();
      return ingestResult();
    });
    const deps = depsFor({
      consumeTokenUse: vi.fn(async (tokenUse) => {
        await Promise.resolve();
        if (used.has(tokenUse.jti)) return "replay";
        used.add(tokenUse.jti);
        return "consumed";
      }),
      ingest,
    });

    const [first, second] = await Promise.all([
      handleSarifIngest(req({ sarif: minimalSarif() }), ctx, deps),
      handleSarifIngest(req({ sarif: minimalSarif() }), ctx, deps),
    ]);

    expect([first.status, second.status].toSorted()).toEqual([202, 401]);
    expect(deps.consumeTokenUse).toHaveBeenCalledTimes(2);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(parseSarif).toHaveBeenCalledTimes(1);
    expect(resolveCloneUrl).toHaveBeenCalledTimes(1);
  });
});

function depsFor(overrides: Partial<SarifRouteDeps> = {}): SarifRouteDeps {
  return {
    authenticate: vi.fn(() => ({
      installationId: 123,
      owner: "AntFleet",
      repo: "bench",
      tokenUse: {
        jti: "00000000-0000-4000-8000-000000000123",
        keyId: "sarif-hmac-v1",
        installationId: 123,
        repo: "AntFleet/bench",
      },
    })),
    enabled: vi.fn(async () => true),
    hasRepoAccess: vi.fn(async () => true),
    consumeTokenUse: vi.fn(async (): Promise<"consumed" | "replay"> => "consumed"),
    ingest: vi.fn(async () => ingestResult()),
    ...overrides,
  };
}

function ingestResult(): Awaited<ReturnType<SarifRouteDeps["ingest"]>> {
  return {
    batchId: "00000000-0000-4000-8000-000000000001",
    parsed: {
      sourceTool: "codeql" as const,
      sourceToolName: "CodeQL",
      sourceRevision: null,
      findings: [],
    },
    stats: {
      totalClaims: 0,
      realCount: 0,
      falsePositiveCount: 0,
      inconclusiveCount: 0,
      errorCount: 0,
    },
  };
}

function req(body: unknown): NextRequest {
  return rawReq(JSON.stringify(body), { "content-type": "application/json" });
}

function rawReq(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://www.antfleet.dev/api/repos/AntFleet/bench/sarif", {
    method: "POST",
    headers: { authorization: "Bearer test", ...headers },
    body,
  });
}

function minimalSarif(): string {
  return JSON.stringify({
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: "CodeQL", rules: [] } },
        results: [],
      },
    ],
  });
}
