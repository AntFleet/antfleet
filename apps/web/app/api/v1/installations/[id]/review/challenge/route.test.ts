// Tests for POST /api/v1/installations/{id}/review/challenge.
//
// Issues a single-use nonce. Auth is intentionally absent (the
// signature step on POST .../review is the actual gate); this endpoint
// is allowed to be hit by anyone for any installation. Tests pin:
//   - 200 happy path: issues challenge_id + canonical challenge string
//   - 404 when install row missing
//   - 409 when wallet is missing / unbound

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleIssueReviewChallenge, type IssueReviewChallengeDeps } from "./route";
import type { PaywallInstallationRow, ReviewChallengeRow } from "@/lib/paywall/queries";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-05-22T14:30:00.000Z");

function row(overrides: Partial<PaywallInstallationRow> = {}): PaywallInstallationRow {
  return {
    id: ROW_ID,
    status: "active",
    walletAddress: WALLET,
    walletProofSignature: `0x${"a".repeat(130)}`,
    walletBoundAt: new Date("2026-05-20T00:00:00.000Z"),
    legacyPartner: false,
    installationId: 12345,
    owner: "acme",
    repo: "demo",
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    ...overrides,
  };
}

function deps(overrides: Partial<IssueReviewChallengeDeps> = {}): IssueReviewChallengeDeps {
  return {
    loadInstallation: vi.fn(async () => row()),
    insertChallenge: vi.fn(
      async (args): Promise<ReviewChallengeRow> => ({
        id: CHALLENGE_ID,
        installationRowId: args.installationRowId,
        issuedAt: args.issuedAt,
        expiresAt: args.expiresAt,
        usedAt: null,
        usedForReviewId: null,
      }),
    ),
    now: () => NOW,
    ...overrides,
  };
}

const ctx = { params: Promise.resolve({ id: ROW_ID }) };
const req = new NextRequest(`http://test.local/api/v1/installations/${ROW_ID}/review/challenge`, {
  method: "POST",
});

describe("POST /api/v1/installations/{id}/review/challenge", () => {
  it("issues a fresh challenge with 10-min TTL and the canonical string format", async () => {
    const res = await handleIssueReviewChallenge(req, ctx, deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["challenge_id"]).toBe(CHALLENGE_ID);
    expect(body["installation_id"]).toBe(ROW_ID);
    expect(body["wallet_address"]).toBe(WALLET);
    expect(body["challenge"]).toBe(
      `AntFleet review: ${CHALLENGE_ID} ${ROW_ID} ${WALLET} ${NOW.toISOString()}`,
    );
    const expiry = new Date(body["expires_at"] as string).getTime() - NOW.getTime();
    expect(expiry).toBe(10 * 60 * 1000);
  });

  it("returns 404 when the installation row is missing", async () => {
    const d = deps({ loadInstallation: vi.fn(async () => null) });
    const res = await handleIssueReviewChallenge(req, ctx, d);
    expect(res.status).toBe(404);
  });

  it("returns 409 when the installation has no wallet bound", async () => {
    const d = deps({
      loadInstallation: vi.fn(async () => row({ walletAddress: null, walletBoundAt: null })),
    });
    const res = await handleIssueReviewChallenge(req, ctx, d);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_wallet");
  });

  it("returns 409 when the wallet exists but binding never completed", async () => {
    const d = deps({
      loadInstallation: vi.fn(async () => row({ status: "pending_binding", walletBoundAt: null })),
    });
    const res = await handleIssueReviewChallenge(req, ctx, d);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("wallet_not_bound");
  });
});
