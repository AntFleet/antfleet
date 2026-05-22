// Integration tests for POST /api/v1/installations/{id}/review.
//
// Drives the route through its exported handleReviewRequest with a
// fully-mocked deps surface — no real Postgres, no real GitHub. Pins
// the contract for:
//   - 400 on missing target / malformed body
//   - 401 on bad / expired / used / cross-install challenge
//   - 401 on signature mismatch
//   - 402 with required/current breakdown on insufficient balance
//   - 200 happy path: gate → debit → worker → finding response
//   - 200 cached on duplicate (isNew=false): no debit, finding returned
//   - 501 on ?force=true (v1 boundary)
//   - 409 on missing wallet / missing install_id
//
// The webhook flow exercises debitForReview via its own tests; here we
// confirm the API surface returns the right HTTP code and body shape
// for each gate decision.

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleReviewRequest, type ReviewEndpointDeps, type ReviewOctokit } from "./route";
import type { GateDecision } from "@/lib/paywall/gate";
import type {
  PaywallInstallationRow,
  ReviewChallengeRow,
  ReviewResponsePayload,
} from "@/lib/paywall/queries";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const CHALLENGE_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const SIG = `0x${"a".repeat(130)}`;
const GH_INSTALL = 12345;
const OWNER = "acme";
const REPO = "demo";
const PR = 7;
const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

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

function reviewPayload(overrides: Partial<ReviewResponsePayload> = {}): ReviewResponsePayload {
  return {
    reviewId: REVIEW_ID,
    installationId: GH_INSTALL,
    owner: OWNER,
    repo: REPO,
    prNumber: PR,
    commitSha: SHA,
    agreementDecision: {
      agreed: [
        {
          title: "Off-by-one in date math",
          severity: "high",
          category: "bug",
          confidence: "high",
          evidence: [
            { path: "src/date.ts", startLine: 12, endLine: 14, symbol: null, quote: null },
          ],
          reasoning: "The increment runs before the boundary check.",
          recommendation: "Move the boundary check above the increment.",
        },
      ],
    },
    publicReceipt: true,
    isBenchmark: false,
    prCommentUrl: "https://github.com/acme/demo/pull/7#issuecomment-1",
    processingStatus: "done",
    processingError: null,
    timingMs: 1234,
    costEstimatedUsd: "0.0500",
    findingIds: [`${REVIEW_ID.slice(0, 8)}-0`],
    ...overrides,
  };
}

function octokitStub(opts?: {
  prSha?: string;
  prNumber?: number;
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
    enqueueReview: vi.fn(async () => ({ reviewId: REVIEW_ID, isNew: true })),
    debitForReview: vi.fn(async () => ({
      ok: true as const,
      debitedUsdc: "0.500000",
      newBalanceUsdc: "0.500000",
      drawdownId: "drawdown-1" as string | null,
    })),
    claimChallenge: vi.fn(async () => true),
    linkChallengeToReview: vi.fn(async () => undefined),
    markReviewTerminallyFailed: vi.fn(async () => undefined),
    runReviewWorker: vi.fn(async () => ({
      kind: "done" as const,
      reviewId: REVIEW_ID,
      agreedCount: 1,
      degraded: false,
    })),
    loadReviewForResponse: vi.fn(async () => reviewPayload()),
    loadChannelBalance: vi.fn(async () => "0.500000"),
    getInstallationToken: vi.fn(async () => "ghs_token"),
    makeOctokit: vi.fn(() => octokitStub({ prSha: SHA })),
    isPublicRepo: vi.fn(async () => true),
    isBenchmarkRepo: vi.fn(async () => false),
    getPriceUsdc: () => "0.50",
    now: () => NOW,
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

describe("POST /api/v1/installations/{id}/review", () => {
  it("happy path: verifies sig, debits channel, runs worker, returns finding", async () => {
    const d = deps();
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["cached"]).toBe(false);
    expect(body["findings"]).toHaveLength(1);
    expect((body["finding"] as { title: string }).title).toBe("Off-by-one in date math");
    expect(body["receipt"]).toMatchObject({
      review_id: REVIEW_ID,
      repo: { owner: OWNER, name: REPO },
      pr_number: PR,
      sha: SHA,
      public_receipt: true,
      finding_count: 1,
    });
    expect(body["channel"]).toMatchObject({
      debited_usdc: "0.500000",
      remaining_usdc: "0.500000",
      drawdown_id: "drawdown-1",
    });
    expect(d.debitForReview).toHaveBeenCalledTimes(1);
    expect(d.runReviewWorker).toHaveBeenCalledTimes(1);
    expect(d.claimChallenge).toHaveBeenCalledTimes(1);
    expect(d.linkChallengeToReview).toHaveBeenCalledTimes(1);
  });

  it("cached path (isNew=false): skips debit and worker, returns cached finding", async () => {
    const d = deps({
      enqueueReview: vi.fn(async () => ({ reviewId: REVIEW_ID, isNew: false })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["cached"]).toBe(true);
    expect(body["findings"]).toHaveLength(1);
    expect((body["channel"] as { debited_usdc: unknown }).debited_usdc).toBeNull();
    expect((body["channel"] as { drawdown_id: unknown }).drawdown_id).toBeNull();
    expect(d.debitForReview).not.toHaveBeenCalled();
    expect(d.runReviewWorker).not.toHaveBeenCalled();
    // Challenge is still consumed — single-use even on cached returns.
    expect(d.claimChallenge).toHaveBeenCalledTimes(1);
    expect(d.linkChallengeToReview).toHaveBeenCalledTimes(1);
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
    expect(d.debitForReview).not.toHaveBeenCalled();
    expect(d.enqueueReview).not.toHaveBeenCalled();
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
    expect(d.debitForReview).not.toHaveBeenCalled();
    expect(d.claimChallenge).not.toHaveBeenCalled();
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
    // After PR #48's reorder (post-Phase-4 fix), claim happens BEFORE
    // enqueue — so a lost race must NOT create a stale reviews row that
    // would later need terminal failure. The flow short-circuits at the
    // claim, returning 401 immediately. Pins this property so a future
    // refactor doesn't silently re-introduce the stale-row regression.
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
    expect(d.enqueueReview).not.toHaveBeenCalled();
    expect(d.debitForReview).not.toHaveBeenCalled();
    expect(d.runReviewWorker).not.toHaveBeenCalled();
    expect(d.markReviewTerminallyFailed).not.toHaveBeenCalled();
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["receipt"] as { pr_number: number }).pr_number).toBe(PR);
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

  it("rejects pr_number requests when the PR is closed (matches webhook semantics)", async () => {
    // The webhook only dispatches on opened/reopened/synchronize. The
    // on-demand endpoint must mirror that so callers can't pay to review
    // a long-closed PR. This is the post-Phase-4 fix; the prior code
    // would happily debit USDC for a review of a merged PR.
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
    expect(d.debitForReview).not.toHaveBeenCalled();
    expect(d.enqueueReview).not.toHaveBeenCalled();
  });

  it("accepts body.repo with different case than install row (GitHub slugs are case-insensitive)", async () => {
    // body.repo "ACME/Demo" must match install row "acme/demo". The
    // canonical case from the install row flows through to the gate
    // lookup so the (installation_id, repo) unique index still hits.
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Receipt repo reflects the install row's canonical case, not the
    // caller's input case.
    expect(body["receipt"]).toMatchObject({
      repo: { owner: OWNER, name: REPO },
    });
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

  it("propagates worker failure as 502", async () => {
    const d = deps({
      runReviewWorker: vi.fn(async () => ({
        kind: "failed" as const,
        reviewId: REVIEW_ID,
        attempts: 1,
        error: "model timeout",
      })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("review_failed");
  });

  it("propagates worker transient retry as 503 (cron will finish it)", async () => {
    const d = deps({
      runReviewWorker: vi.fn(async () => ({
        kind: "retried" as const,
        reviewId: REVIEW_ID,
        attempts: 1,
        nextRetryAt: new Date(NOW.getTime() + 60_000),
        error: "rate_limited",
      })),
    });
    const res = await handleReviewRequest(
      req({ challenge_id: CHALLENGE_ID, signature: SIG, pr_number: PR }),
      ctx,
      d,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("review_in_progress");
  });
});
