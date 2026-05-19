import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { buildClaimMessage } from "@/lib/claim-message";
import { handleClaim, type ClaimDeps } from "./route";

const NOW = new Date("2026-05-19T11:00:00.000Z");
const TOKEN = "0x1111111111111111111111111111111111111111";
const TOKEN_2 = "0x2222222222222222222222222222222222222222";
const DEPLOYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPO = "AntFleet/agent-one";
const REPO_2 = "Other/agent-two";
const SIGNATURE = `0x${"a".repeat(130)}`;

type LaunchRow = { deployerAddress: string; repoFullName: string | null };
type ClaimRow = { id: string; repoFullName: string };

class FakeDb {
  step = 0;
  inserts: unknown[] = [];
  launch: LaunchRow | null = { deployerAddress: DEPLOYER, repoFullName: null };
  verifiedClaim: ClaimRow | null = null;
  recentAttempts = 0;

  async transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async execute(): Promise<unknown> {
    const step = this.step++;
    if (step === 0) return this.launch === null ? [] : [this.launch];
    if (step === 1) return [{ value: this.recentAttempts }];
    if (step === 2) return this.verifiedClaim === null ? [] : [this.verifiedClaim];
    if (step === 3) {
      this.inserts.push({});
      return { rowCount: 1 };
    }
    if (step === 4) {
      if (this.launch?.repoFullName === null) {
        this.launch.repoFullName = "antfleet/agent-one";
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }
    if (step === 5) return this.launch === null ? [] : [this.launch];
    return [];
  }
}

class UniqueViolationDb extends FakeDb {
  attemptedInserts = 0;
  persistedInserts = 0;

  override async execute(): Promise<unknown> {
    const step = this.step++;
    if (step === 0) return this.launch === null ? [] : [this.launch];
    if (step === 1) return [{ value: this.recentAttempts }];
    if (step === 2) return [];
    if (step === 3) {
      this.attemptedInserts += 1;
      const err = new Error("duplicate key value violates unique constraint");
      (err as { code?: string }).code = "23505";
      throw err;
    }
    return [];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(payload: unknown): NextRequest {
  return { json: vi.fn().mockResolvedValue(payload) } as unknown as NextRequest;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    tokenAddress: TOKEN,
    repoFullName: REPO,
    signature: SIGNATURE,
    message: buildClaimMessage({
      tokenAddress: TOKEN,
      repoFullName: REPO,
      nonce: "nonce_123456",
      timestamp: NOW.toISOString(),
    }),
    ...overrides,
  };
}

function deps(db = new FakeDb(), overrides: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    db: db as unknown as ClaimDeps["db"],
    octokit: { rest: { repos: { get: vi.fn() } } },
    recoverMessageAddress: vi.fn().mockResolvedValue(DEPLOYER),
    isPublicRepo: vi.fn().mockResolvedValue(true),
    createClaimId: vi.fn(() => "claim_123"),
    now: vi.fn(() => NOW),
    ...overrides,
  } as ClaimDeps;
}

describe("handleClaim", () => {
  it("verifies a valid deployer signature, inserts the claim, and attributes the launch", async () => {
    const fakeDb = new FakeDb();
    const claimDeps = deps(fakeDb);
    const res = await handleClaim(makeReq(body()), claimDeps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimId: "claim_123", agentUrl: `/agents/${TOKEN}` });
    expect(claimDeps.isPublicRepo).toHaveBeenCalledWith(
      expect.any(Object),
      "antfleet",
      "agent-one",
    );
    expect(claimDeps.recoverMessageAddress).toHaveBeenCalledWith({
      message: body().message,
      signature: SIGNATURE,
    });
    expect(fakeDb.inserts).toHaveLength(1);
    expect(fakeDb.launch?.repoFullName).toBe("antfleet/agent-one");
  });

  it("rejects body parse failures", async () => {
    const res = await handleClaim(makeReq(body({ tokenAddress: "bad" })), deps());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad-request" });
  });

  it("rejects when body fields do not match the signed message", async () => {
    const res = await handleClaim(
      makeReq(
        body({
          message: buildClaimMessage({
            tokenAddress: TOKEN_2,
            repoFullName: REPO,
            nonce: "nonce_123456",
            timestamp: NOW.toISOString(),
          }),
        }),
      ),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "message-mismatch" });
  });

  it("rejects stale signatures older than ten minutes", async () => {
    const stale = new Date(NOW.getTime() - 15 * 60 * 1000).toISOString();
    const res = await handleClaim(
      makeReq(
        body({
          message: buildClaimMessage({
            tokenAddress: TOKEN,
            repoFullName: REPO,
            nonce: "nonce_123456",
            timestamp: stale,
          }),
        }),
      ),
      deps(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "stale-signature" });
  });

  it("returns 404 when the token is unknown", async () => {
    const fakeDb = new FakeDb();
    fakeDb.launch = null;
    const res = await handleClaim(makeReq(body()), deps(fakeDb));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "token-not-found" });
  });

  it("rate-limits the fourth claim attempt in seven days", async () => {
    const fakeDb = new FakeDb();
    fakeDb.recentAttempts = 3;
    const res = await handleClaim(makeReq(body()), deps(fakeDb));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate-limited" });
  });

  it("rejects private or missing repositories", async () => {
    const res = await handleClaim(
      makeReq(body()),
      deps(new FakeDb(), { isPublicRepo: vi.fn().mockResolvedValue(false) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repo-not-public" });
  });

  it("rejects signatures that recover to a non-deployer address", async () => {
    const res = await handleClaim(
      makeReq(body()),
      deps(new FakeDb(), { recoverMessageAddress: vi.fn().mockResolvedValue(OTHER) }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "signature-mismatch" });
  });

  it("is idempotent for an already verified token and repo pair", async () => {
    const fakeDb = new FakeDb();
    fakeDb.verifiedClaim = { id: "existing_claim", repoFullName: "antfleet/agent-one" };
    const res = await handleClaim(makeReq(body()), deps(fakeDb));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimId: "existing_claim", agentUrl: `/agents/${TOKEN}` });
    expect(fakeDb.inserts).toHaveLength(0);
  });

  it("rejects when the launch is already attributed to a different repo", async () => {
    const fakeDb = new FakeDb();
    fakeDb.launch = { deployerAddress: DEPLOYER, repoFullName: "other/repo" };
    const res = await handleClaim(makeReq(body()), deps(fakeDb));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already-attributed" });
    expect(fakeDb.inserts).toHaveLength(0);
  });

  it("does not duplicate rows when a signature is replayed within the claim window", async () => {
    const fakeDb = new FakeDb();
    const claimDeps = deps(fakeDb);

    const first = await handleClaim(makeReq(body()), claimDeps);
    expect(first.status).toBe(200);
    expect(fakeDb.inserts).toHaveLength(1);

    fakeDb.step = 0;
    fakeDb.verifiedClaim = { id: "claim_123", repoFullName: "antfleet/agent-one" };

    const second = await handleClaim(makeReq(body()), claimDeps);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ claimId: "claim_123", agentUrl: `/agents/${TOKEN}` });
    expect(fakeDb.inserts).toHaveLength(1);
  });

  it("returns 409 and does not persist a second insert when a concurrent claim hits the unique constraint", async () => {
    const firstDb = new FakeDb();
    const first = await handleClaim(makeReq(body()), deps(firstDb));
    expect(first.status).toBe(200);
    expect(firstDb.inserts).toHaveLength(1);

    const racingDb = new UniqueViolationDb();
    const second = await handleClaim(
      makeReq(
        body({
          repoFullName: REPO_2,
          message: buildClaimMessage({
            tokenAddress: TOKEN,
            repoFullName: REPO_2,
            nonce: "nonce_race_123",
            timestamp: NOW.toISOString(),
          }),
        }),
      ),
      deps(racingDb),
    );

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "already-attributed" });
    expect(racingDb.attemptedInserts).toBe(1);
    expect(racingDb.persistedInserts).toBe(0);
  });
});
