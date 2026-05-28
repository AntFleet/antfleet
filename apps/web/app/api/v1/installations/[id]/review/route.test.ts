// Integration tests for POST /api/v1/installations/{id}/review (async contract).
//
// POST now returns 202 + jobId (async enqueue). The worker runs via after().
// Tests pin the contract for:
//   - 202 happy path: auth → debit → job row → 202 + jobId
//   - 400 on missing target / malformed body
//   - 401 on bad / expired / used / cross-install challenge
//   - 401 on signature mismatch
//   - 402 with required/current breakdown on insufficient balance
//   - 410 Gone on ?legacy=true
//   - 501 on ?force=true
//   - 409 on missing wallet / missing install_id

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleReviewRequest, type ReviewEndpointDeps, type ReviewOctokit } from "./route";
import type { GateDecision } from "@/lib/paywall/gate";
import type { PaywallInstallationRow, ReviewChallengeRow } from "@/lib/paywall/queries";
import type { ReviewJobRow } from "@/lib/review-job-queries";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SIG = `0x${"a".repeat(130)}`;
const GH_INSTALL = 12345;
const OWNER = "acme";
const REPO = "demo";
const PR = 7;
const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const JOB_ID = "test-job-id-123456789";

const ISSUED_AT = new Date("2026-05-22T14:30:00.000Z");
const NOW = new Date("2026-05-22T14:31:00.000Z");
const EXPIRES_AT = new Date(ISSUED_AT.getTime() + 10 * 60 * 1000);

function install(overrides: Partial<PaywallInstallationRow> = {}): PaywallInstallationRow {
  return {
    id: ROW_ID,
    status: "active",
    walletAddress: WALLET,
    walletProofSignature: SIG,
    walletBoundAt: new Date("2026-05-20T00:00:00.000Z"),
    legacyPartner: false,
    installationId: GH_INSTALL,
    owner: OWNER,
    repo: REPO,
    createdAt: new Date("2026-05-20T00:00:00.000Z"),
    ...overrides,
  };
}

function challengeRow(overrides: Partial<ReviewChallengeRow> = {}): ReviewChallengeRow {
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

function debitGate(): Extract<GateDecision, { kind: "debit" }> {
  return {
    kind: "debit",
    installationRowId: ROW_ID,
    channelId: CHANNEL_ID,
    balanceUsdc: "1.000000",
    priceUsdc: "0.50",
    walletAddress: WALLET,
  };
}

function jobRow(overrides: Partial<ReviewJobRow> = {}): ReviewJobRow {
  return {
    jobId: JOB_ID,
    installationId: ROW_ID,
    walletAddress: WALLET,
    repoOwner: OWNER,
    repoName: REPO,
    prNumber: PR,
    sha: SHA,
    idempotencyKey: null,
    status: "queued",
    failureMode: null,
    failureMessage: null,
    result: null,
    debitPaymentId: null,
    refundPaymentId: null,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

function octokitStub(opts?: {
  prSha?: string;
  prState?: string;
  associatedPrs?: Array<{ number: number; state: string; headSha: string }>;
  prThrow?: { status: number };
}): ReviewOctokit {
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => {
          if (opts?.prThrow !== undefined) {
            const err: Error & { status?: number } = new Error("not found");
            err.status = opts.prThrow.status;
            throw err;
          }
          return { data: { state: opts?.prState ?? "open", head: { sha: opts?.prSha ?? SHA } } };
        }),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: vi.fn(async () => ({
          data: (opts?.associatedPrs ?? []).map((p) => ({
            number: p.number,
            state: p.state,
            head: { sha: p.headSha },
          })),
        })),
      },
    },
  };
}

function deps(overrides: Partial<ReviewEndpointDeps> = {}): ReviewEndpointDeps {
  return {
    loadInstallation: vi.fn(async () => install()),
    loadChallenge: vi.fn(async () => challengeRow()),
    recoverMessageAddress: vi.fn(async () => WALLET),
    decideGate: vi.fn(async () => debitGate() as GateDecision),
    debitForJob: vi.fn(async () => ({
      ok: true as const,
      debitedUsdc: "0.500000",
      newBalanceUsdc: "0.500000",
      drawdownId: "drawdown-1" as string | null,
    })),
    claimChallenge: vi.fn(async () => true),
    linkChallengeToReview: vi.fn(async () => undefined),
    getInstallationToken: vi.fn(async () => "ghs_token"),
    makeOctokit: vi.fn(() => octokitStub({ prSha: SHA })),
    getPriceUsdc: () => "0.50",
    now: () => NOW,
    createReviewJob: vi.fn(async () => jobRow()),
    findJobByIdempotencyKey: vi.fn(async () => null),
    linkDebitToJob: vi.fn(async () => undefined),
    markBillingJobFailed: vi.fn(async () => undefined),
    markJobQueued: vi.fn(async () => true),
    scheduleWorker: vi.fn(),
    ...overrides,
  };
}

function req(body: unknown, opts?: { searchParams?: string }): NextRequest {
  const sp = opts?.searchParams ? `?${opts.searchParams}` : "";
  return new NextRequest(`http://test.local/api/v1/installations/${ROW_ID}/review${sp}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: ROW_ID }) };

describe("POST /api/v1/installations/{id}/review (async)", () => {
  it("happy path: verifies sig, debits channel, enqueues job, returns 202 + jobId", async () => {
    const d = deps();
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["jobId"]).toBe(JOB_ID);
    expect(body["statusUrl"]).toBe(`/api/v1/installations/${ROW_ID}/review/${JOB_ID}`);
    expect(body["expectedDurationSec"]).toBe(180);
    expect(d.debitForJob).toHaveBeenCalledTimes(1);
    expect(d.createReviewJob).toHaveBeenCalledTimes(1);
    expect(d.createReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ initialStatus: "billing_pending" }),
    );
    expect(d.markJobQueued).toHaveBeenCalledWith(JOB_ID);
    expect(d.scheduleWorker).toHaveBeenCalledWith(JOB_ID);
    expect(d.claimChallenge).toHaveBeenCalledTimes(1);
    expect(d.linkChallengeToReview).toHaveBeenCalledTimes(1);
  });

  it("returns 410 Gone on ?legacy=true", async () => {
    const res = await handleReviewRequest(
      req(
        { challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR },
        { searchParams: "legacy=true" },
      ),
      ctx,
      deps(),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sync_mode_removed");
  });

  it("returns 401 when signature does not recover to the bound wallet", async () => {
    const d = deps({
      recoverMessageAddress: vi.fn(async () => "0x1111111111111111111111111111111111111111"),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("signature_mismatch");
    expect(d.debitForJob).not.toHaveBeenCalled();
    expect(d.createReviewJob).not.toHaveBeenCalled();
  });

  it("returns 402 with required/current on insufficient balance at the gate", async () => {
    const d = deps({
      decideGate: vi.fn(
        async () =>
          ({
            kind: "insufficient",
            installationRowId: ROW_ID,
            channelId: CHANNEL_ID,
            balanceUsdc: "0.250000",
            priceUsdc: "0.50",
            walletAddress: WALLET,
          }) as GateDecision,
      ),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["error"] as { code: string }).code).toBe("insufficient_channel_balance");
    expect(body["required_usdc"]).toBe("0.50");
    expect(body["current_usdc"]).toBe("0.250000");
    expect(d.debitForJob).not.toHaveBeenCalled();
    expect(d.claimChallenge).not.toHaveBeenCalled();
  });

  it("marks the billing-pending job failed when debit loses the balance race", async () => {
    const d = deps({
      debitForJob: vi.fn(async () => ({
        ok: false as const,
        reason: "insufficient_at_debit" as const,
      })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["error"] as { code: string }).code).toBe("insufficient_channel_balance");
    expect(d.createReviewJob).toHaveBeenCalledWith(
      expect.objectContaining({ initialStatus: "billing_pending" }),
    );
    expect(d.markBillingJobFailed).toHaveBeenCalledWith(
      JOB_ID,
      "insufficient_channel_balance",
      "channel balance dropped below review price before debit",
      NOW,
    );
    expect(d.markJobQueued).not.toHaveBeenCalled();
    expect(d.scheduleWorker).not.toHaveBeenCalled();
  });

  it("returns 401 when challenge_id is not found", async () => {
    const d = deps({ loadChallenge: vi.fn(async () => null) });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unknown_challenge");
  });

  it("returns 401 when challenge was already redeemed", async () => {
    const d = deps({
      loadChallenge: vi.fn(async () => challengeRow({ usedAt: new Date() })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("challenge_already_used");
  });

  it("returns 401 when challenge has expired", async () => {
    const d = deps({
      loadChallenge: vi.fn(async () => challengeRow({ expiresAt: new Date(NOW.getTime() - 1000) })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("expired_challenge");
  });

  it("returns 401 when challenge was issued for a different installation", async () => {
    const d = deps({
      loadChallenge: vi.fn(async () =>
        challengeRow({ installationRowId: "00000000-0000-4000-8000-0000000000ff" }),
      ),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("challenge_install_mismatch");
  });

  it("returns 401 with NO side effects when challenge claim loses the race", async () => {
    const d = deps({
      claimChallenge: vi.fn(async () => false),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("challenge_already_used");
    expect(d.debitForJob).not.toHaveBeenCalled();
    expect(d.createReviewJob).not.toHaveBeenCalled();
    expect(d.scheduleWorker).not.toHaveBeenCalled();
  });

  it("returns 400 when neither pr_number nor sha is provided", async () => {
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG }),
      ctx,
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  it("returns 400 when signature is malformed", async () => {
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: "0xshort", pr_number: PR }),
      ctx,
      deps(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  it("returns 404 when installation row not found", async () => {
    const d = deps({ loadInstallation: vi.fn(async () => null) });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 when installation has no bound wallet", async () => {
    const d = deps({
      loadInstallation: vi.fn(async () => install({ walletAddress: null, walletBoundAt: null })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_wallet");
  });

  it("returns 409 when GitHub App hasn't completed installation yet", async () => {
    const d = deps({ loadInstallation: vi.fn(async () => install({ installationId: null })) });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("github_app_not_installed");
  });

  it("returns 501 on ?force=true (v1 boundary)", async () => {
    const res = await handleReviewRequest(
      req(
        { challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR },
        { searchParams: "force=true" },
      ),
      ctx,
      deps(),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("force_not_yet_supported");
  });

  it("resolves sha-only requests to a single open PR via GitHub API", async () => {
    const d = deps({
      makeOctokit: vi.fn(() =>
        octokitStub({
          associatedPrs: [{ number: PR, state: "open", headSha: SHA }],
        }),
      ),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, sha: SHA }),
      ctx,
      d,
    );
    expect(res.status).toBe(202);
    expect(d.createReviewJob).toHaveBeenCalledTimes(1);
  });

  it("rejects sha-only requests when no open PR matches", async () => {
    const d = deps({
      makeOctokit: vi.fn(() => octokitStub({ associatedPrs: [] })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, sha: SHA }),
      ctx,
      d,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sha_has_no_open_pr");
  });

  it("rejects pr_number requests when the PR is closed", async () => {
    const d = deps({
      makeOctokit: vi.fn(() => octokitStub({ prState: "closed", prSha: SHA })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("pr_not_open");
    expect(d.debitForJob).not.toHaveBeenCalled();
    expect(d.createReviewJob).not.toHaveBeenCalled();
  });

  it("accepts body.repo with different case than install row", async () => {
    const d = deps();
    const res = await handleReviewRequest(
      req({
        challenge_id: CHALLENGE_ID,
        signature: SIG,
        pr_number: PR,
        repo: `${OWNER.toUpperCase()}/${REPO.toUpperCase()}`,
      }),
      ctx,
      d,
    );
    expect(res.status).toBe(202);
  });

  it("rejects sha-only requests when multiple open PRs match", async () => {
    const d = deps({
      makeOctokit: vi.fn(() =>
        octokitStub({
          associatedPrs: [
            { number: PR, state: "open", headSha: SHA },
            { number: PR + 1, state: "open", headSha: SHA },
          ],
        }),
      ),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, sha: SHA }),
      ctx,
      d,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sha_matches_multiple_prs");
  });

  it("returns 502 when getInstallationToken fails", async () => {
    const d = deps({
      getInstallationToken: vi.fn(async () => {
        throw new Error("private key rotated");
      }),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("github_auth_failed");
  });

  it("returns existing job on idempotency_key match (no new debit)", async () => {
    const d = deps({
      findJobByIdempotencyKey: vi.fn(async () =>
        jobRow({ idempotencyKey: "my-key", status: "running" }),
      ),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR, idempotency_key: "my-key" }),
      ctx,
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["jobId"]).toBe(JOB_ID);
    expect(body["status"]).toBe("running");
    // No new debit or job creation
    expect(d.debitForJob).not.toHaveBeenCalled();
    expect(d.createReviewJob).not.toHaveBeenCalled();
    expect(d.scheduleWorker).not.toHaveBeenCalled();
  });
});
