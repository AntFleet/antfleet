// Integration test: exercises the REAL undici Agent + the real production
// fetchMetadataJson wiring against a local HTTP server, with no mocking
// of undici. The unit suite in repo-discovery.test mocks both Agent and
// fetch, which means a bad lookup-callback signature like the one the
// round-3 security auditor caught silently passes there. This file is the
// safety net for that class of regression.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";
import { fetchWithPinnedTarget } from "./repo-discovery";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      // Redirect to a private address — fetchMetadataJson must refuse
      // to follow even though the originating server is bound to a
      // local loopback we whitelisted via the URL literal.
      res.writeHead(302, { location: "http://10.0.0.1/secret" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("bad address");
  port = addr.port;
});

afterAll(() => {
  server.close();
});

describe("undici Agent connect.lookup signature (round-3 regression)", () => {
  it("the addresses-array form succeeds against a real socket", async () => {
    const agent = new Agent({
      connect: {
        lookup: (_h, _o, cb) => {
          cb(null, [{ address: "127.0.0.1", family: 4 }]);
        },
      },
    });
    try {
      const response = await undiciFetch(`http://example.invalid:${port}/`, {
        dispatcher: agent,
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true });
    } finally {
      await agent.close();
    }
  });

  it("production fetchWithPinnedTarget builds a real dispatcher + completes a real HTTP round-trip", async () => {
    // This is the load-bearing production-path test: it calls into the
    // real fetchWithPinnedTarget exported from repo-discovery.ts. A
    // future regression that breaks the lookup callback shape, the
    // dispatcher construction, or the undici fetch wiring fails here
    // even though the unit suite mocks undici.
    const result = await fetchWithPinnedTarget(`http://example.invalid:${port}/`, {
      parsed: new URL(`http://example.invalid:${port}/`),
      address: "127.0.0.1",
      family: 4,
    });
    expect(result).toEqual({ ok: true });
  });

  it("production fetchWithPinnedTarget refuses to follow a redirect into a private address", async () => {
    // Server 302s to http://10.0.0.1/secret. The real allowlist must
    // refuse before issuing the second request.
    const result = await fetchWithPinnedTarget(`http://example.invalid:${port}/redirect`, {
      parsed: new URL(`http://example.invalid:${port}/redirect`),
      address: "127.0.0.1",
      family: 4,
    });
    expect(result).toBe(null);
  });

  it("the dns.lookup tuple form (cb(null, address, family)) FAILS — keep using the array form", async () => {
    // This documents the shape the round-3 auditor probe caught. If a
    // future refactor reverts to the tuple form, this test fails fast.
    const agent = new Agent({
      connect: {
        lookup: (_h, _o, cb) => {
          (cb as (e: unknown, a: string, f: number) => void)(null, "127.0.0.1", 4);
        },
      },
    });
    try {
      await expect(
        undiciFetch(`http://example.invalid:${port}/`, { dispatcher: agent }),
      ).rejects.toThrow();
    } finally {
      await agent.close();
    }
  });
});
