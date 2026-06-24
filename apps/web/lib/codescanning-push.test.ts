import { describe, expect, it } from "vitest";
import { pushSarifToCodeScanning, type CodeScanningPushInput } from "./codescanning-push";
import type { SarifLog } from "./sarif-export";

const SARIF: SarifLog = {
  $schema:
    "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
  version: "2.1.0",
  runs: [{ tool: { driver: { name: "AntFleet" } }, results: [] }],
};

const BASE_INPUT: CodeScanningPushInput = {
  owner: "AntFleet",
  repo: "bench-orlixai",
  commitSha: "1111111111111111111111111111111111111111",
  ref: "refs/heads/main",
  sarif: SARIF,
};

function captureFetch(): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
  setResponse: (status: number, body: string) => void;
  throwOnNext: (err: Error) => void;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let nextStatus = 202;
  let nextBody = JSON.stringify({ id: "abc123", url: "https://api.github.com/x/abc123" });
  let throwErr: Error | null = null;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (throwErr !== null) {
      const e = throwErr;
      throwErr = null;
      throw e;
    }
    return new Response(nextBody, { status: nextStatus });
  };
  return {
    fetchImpl,
    calls,
    setResponse: (status, body) => {
      nextStatus = status;
      nextBody = body;
    },
    throwOnNext: (err) => {
      throwErr = err;
    },
  };
}

describe("pushSarifToCodeScanning", () => {
  it("skips with missing_pat when no PAT in env or deps", async () => {
    const { fetchImpl, calls } = captureFetch();
    const result = await pushSarifToCodeScanning(BASE_INPUT, { pat: undefined, fetchImpl });
    expect(result).toEqual({ kind: "skipped", reason: "missing_pat" });
    expect(calls).toHaveLength(0);
  });

  it("posts to the correct GitHub API URL with the expected headers and gzip+base64 body", async () => {
    const { fetchImpl, calls, setResponse } = captureFetch();
    setResponse(202, JSON.stringify({ id: "id-1", url: "https://api/x/id-1" }));
    const result = await pushSarifToCodeScanning(BASE_INPUT, {
      pat: "ghp_fake",
      fetchImpl,
    });
    expect(result).toMatchObject({ kind: "accepted", id: "id-1", url: "https://api/x/id-1" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://api.github.com/repos/AntFleet/bench-orlixai/code-scanning/sarifs",
    );
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghp_fake");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    const body = JSON.parse(call.init.body as string) as Record<string, unknown>;
    expect(body["commit_sha"]).toBe(BASE_INPUT.commitSha);
    expect(body["ref"]).toBe(BASE_INPUT.ref);
    expect(typeof body["sarif"]).toBe("string");
    expect((body["sarif"] as string).length).toBeGreaterThan(0);
  });

  it("returns rejected with status + body on 403", async () => {
    const { fetchImpl, setResponse } = captureFetch();
    setResponse(403, '{"message":"Resource not accessible by personal access token"}');
    const result = await pushSarifToCodeScanning(BASE_INPUT, {
      pat: "ghp_fake",
      fetchImpl,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.status).toBe(403);
      expect(result.bodyExcerpt).toContain("Resource not accessible");
    }
  });

  it("returns rejected with status + body on 422 (invalid SARIF)", async () => {
    const { fetchImpl, setResponse } = captureFetch();
    setResponse(422, '{"message":"Invalid SARIF","errors":[{"resource":"CodeScanning"}]}');
    const result = await pushSarifToCodeScanning(BASE_INPUT, {
      pat: "ghp_fake",
      fetchImpl,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.status).toBe(422);
    }
  });

  it("returns rejected with network_error on fetch throw", async () => {
    const { fetchImpl, throwOnNext } = captureFetch();
    throwOnNext(new Error("ECONNRESET"));
    const result = await pushSarifToCodeScanning(BASE_INPUT, {
      pat: "ghp_fake",
      fetchImpl,
    });
    expect(result).toEqual({ kind: "rejected", status: 0, bodyExcerpt: "network_error" });
  });

  it("handles 202 with no JSON body as accepted-with-no-id", async () => {
    const { fetchImpl, setResponse } = captureFetch();
    setResponse(202, "");
    const result = await pushSarifToCodeScanning(BASE_INPUT, {
      pat: "ghp_fake",
      fetchImpl,
    });
    expect(result).toEqual({ kind: "accepted", id: null, url: null });
  });

  it("respects apiBase override (for GitHub Enterprise)", async () => {
    const { fetchImpl, calls } = captureFetch();
    await pushSarifToCodeScanning(BASE_INPUT, {
      pat: "ghp_fake",
      fetchImpl,
      apiBase: "https://ghe.example.com/api/v3",
    });
    expect(calls[0]?.url).toBe(
      "https://ghe.example.com/api/v3/repos/AntFleet/bench-orlixai/code-scanning/sarifs",
    );
  });
});
