import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handlePollRequest, OPTIONS, type PollEndpointDeps } from "./route";
import type { PaywallInstallationRow, ReviewChallengeRow } from "@/lib/paywall/queries";
import type { ReviewJobRow } from "@/lib/review-job-queries";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "job-1";
const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SIG = `0x${"a".repeat(130)}`;
const NOW = new Date("2026-05-22T14:31:00.000Z");
const ISSUED_AT = new Date("2026-05-22T14:30:00.000Z");
const EXPIRES_AT = new Date("2026-05-22T14:40:00.000Z");

function install(overrides: Partial<PaywallInstallationRow> = {}): PaywallInstallationRow {
  return {
    id: ROW_ID,
    status: "active",
    walletAddress: WALLET,
    walletProofSignature: SIG,
    walletBoundAt: new Date("2026-05-20T00:00:00.000Z"),
    legacyPartner: false,
    installationId: 12345,
    owner: "acme",
    repo: "demo",
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    ...overrides,
  };
}

function challenge(overrides: Partial<ReviewChallengeRow> = {}): ReviewChallengeRow {
  return {
    id: CHALLENGE_ID,
    installationRowId: ROW_ID,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    usedAt: null,
    usedForReviewId: null,
    ...overrides,
  };
}

function job(overrides: Partial<ReviewJobRow> = {}): ReviewJobRow {
  return {
    jobId: JOB_ID,
    installationId: ROW_ID,
    walletAddress: WALLET,
    repoOwner: "acme",
    repoName: "demo",
    prNumber: 7,
    sha: "deadbeef",
    idempotencyKey: null,
    status: "complete",
    failureMode: null,
    failureMessage: null,
    result: { reviewId: "review-1" },
    debitPaymentId: null,
    refundPaymentId: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

function deps(overrides: Partial<PollEndpointDeps> = {}): PollEndpointDeps {
  return {
    loadInstallation: vi.fn(async () => install()),
    loadChallenge: vi.fn(async () => challenge()),
    recoverMessageAddress: vi.fn(async () => WALLET),
    getReviewJob: vi.fn(async () => job()),
    now: () => NOW,
    ...overrides,
  };
}

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://test.local/api/v1/installations/${ROW_ID}/review/${JOB_ID}`, {
    method: "GET",
    headers,
  });
}

const ctx = { params: Promise.resolve({ id: ROW_ID, jobId: JOB_ID }) };

describe("GET /api/v1/installations/{id}/review/{jobId}", () => {
  it("authenticates with challenge headers and returns the job result", async () => {
    const d = deps();
    const res = await handlePollRequest(
      req({
        "x-antfleet-challenge-id": CHALLENGE_ID,
        "x-antfleet-signature": SIG,
      }),
      ctx,
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("complete");
    expect(body["result"]).toEqual({ reviewId: "review-1" });
    expect(d.loadChallenge).toHaveBeenCalledWith(CHALLENGE_ID);
  });

  it("rejects URL query credentials so signatures do not leak into logs", async () => {
    const d = deps();
    const res = await handlePollRequest(
      new NextRequest(
        `http://test.local/api/v1/installations/${ROW_ID}/review/${JOB_ID}?challenge_id=${CHALLENGE_ID}&signature=${SIG}`,
        { method: "GET" },
      ),
      ctx,
      d,
    );
    expect(res.status).toBe(400);
    expect(d.loadChallenge).not.toHaveBeenCalled();
  });

  it("allows the authentication headers in preflight responses", () => {
    const res = OPTIONS();
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-AntFleet-Challenge-Id");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-AntFleet-Signature");
  });
});
