// Integration test: exercises the REAL undici Agent against a local HTTP
// server, with no mocking of undici. The unit suite in repo-discovery.test
// mocks both Agent and fetch, which means a bad lookup-callback signature
// like the one the round-3 security auditor caught silently passes there.
// This file is the safety net for that class of regression.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
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
