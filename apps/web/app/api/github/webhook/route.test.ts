// Tests for the GitHub App webhook route.
//
// Coverage:
//   (a) Signature validation: invalid/missing → 401, valid → proceeds.
//   (b) Parser safety: each payload parser returns safe null/[] on malformed
//       input without throwing, and the route handles it gracefully.
//   (c) Billing ordering invariant: debitForReview is called ONLY when
//       enqueueReview returns isNew=true; a duplicate delivery (isNew=false)
//       MUST NOT call debitForReview.
//
// All DB / network calls are mocked at module boundaries — no real
// DATABASE_URL, no real GitHub API, no real Neon.

import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must appear before any import of the module under test.
// ---------------------------------------------------------------------------

// We store the after() callback in a simple closure so vi.clearAllMocks()
// doesn't wipe out the reference. The mock implementation is re-registered
// in beforeEach after clearing.
const afterState = { callback: null as (() => Promise<void>) | null };

const nextServerMocks = vi.hoisted(() => ({
  after: vi.fn(),
  // helpers for tests — not mocked, just exported
  flushAfter: async () => {
    if (afterState.callback !== null) {
      await afterState.callback();
      afterState.callback = null;
    }
  },
}));

// next/server exports NextResponse as a class — we need the real implementation
// for JSON / status helpers but replace after() with our spy.
vi.mock("next/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/server")>();
  return {
    ...real,
    after: nextServerMocks.after,
  };
});

const signatureMocks = vi.hoisted(() => ({
  verifyGitHubSignature: vi.fn(),
}));
vi.mock("@/lib/github-signature", () => signatureMocks);

const githubAppMocks = vi.hoisted(() => ({
  getInstallationToken: vi.fn(),
}));
vi.mock("@/lib/github-app", () => githubAppMocks);

const repoVisibilityMocks = vi.hoisted(() => ({
  isPublicRepo: vi.fn(),
}));
vi.mock("@/lib/repo-visibility", () => repoVisibilityMocks);

const repoBenchmarkMocks = vi.hoisted(() => ({
  isBenchmarkRepo: vi.fn(),
}));
vi.mock("@/lib/repo-benchmark", () => repoBenchmarkMocks);

const onboarderMocks = vi.hoisted(() => ({
  isWelcomeIssue: vi.fn(),
  recordPartnerReply: vi.fn(),
  runWelcomeOnInstall: vi.fn(),
}));
vi.mock("@/lib/onboarder", () => onboarderMocks);

const reviewWorkerMocks = vi.hoisted(() => ({
  runReviewWorker: vi.fn(),
}));
vi.mock("@/lib/review-worker", () => reviewWorkerMocks);

const dbQueriesMocks = vi.hoisted(() => ({
  enqueueReview: vi.fn(),
  hashRepo: vi.fn(),
  lookupFindingForInstall: vi.fn(),
  markReviewTerminallyFailed: vi.fn(),
  recordMaintainerReactions: vi.fn(),
  retractFindingByDismiss: vi.fn(),
  upsertInstallEntry: vi.fn(),
}));
vi.mock("@/db/queries", () => dbQueriesMocks);

const precisionFeedbackMocks = vi.hoisted(() => ({
  isPrecisionAutoRetractEnabled: vi.fn(),
  isPrecisionFeedbackEnabledForInstall: vi.fn(),
}));
vi.mock("@/lib/precision-feedback-env", () => precisionFeedbackMocks);

// db itself is only passed as arg to debitForReview — mock the module so
// import succeeds and the value is a stable object reference.
vi.mock("@/db", () => ({ db: {} }));

const gateMocks = vi.hoisted(() => ({
  decideGate: vi.fn(),
  debitForReview: vi.fn(),
}));
vi.mock("@/lib/paywall/gate", () => gateMocks);

const invoiceMocks = vi.hoisted(() => ({
  buildInvoice: vi.fn(),
  renderInvoiceComment: vi.fn(),
}));
vi.mock("@/lib/paywall/invoice", () => invoiceMocks);

const paywallEnvMocks = vi.hoisted(() => ({
  getDepositAddress: vi.fn(),
}));
vi.mock("@/lib/paywall/env", () => paywallEnvMocks);

vi.mock("@/lib/log", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  messageOf: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// Octokit is constructed with `new Octokit({ auth })` in the route.
// Use a proper class so `new Octokit()` works.
vi.mock("@octokit/rest", () => ({
  Octokit: class MockOctokit {
    rest = {
      issues: { createComment: vi.fn().mockResolvedValue({}) },
    };
  },
}));

// ---------------------------------------------------------------------------
// Import route AFTER mocks are registered.
// ---------------------------------------------------------------------------
import { POST, parseDismissCommand } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = "test-webhook-secret";

function makeHmac(body: string, secret = WEBHOOK_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makeRequest(
  body: string,
  opts: {
    signature?: string | null;
    event?: string;
    delivery?: string;
  } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const sig = opts.signature === undefined ? makeHmac(body) : opts.signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  if (opts.event) headers["x-github-event"] = opts.event;
  if (opts.delivery) headers["x-github-delivery"] = opts.delivery;

  return new NextRequest("https://www.antfleet.dev/api/github/webhook", {
    method: "POST",
    body,
    headers,
  });
}

// A valid pull_request opened payload
const PR_PAYLOAD = JSON.stringify({
  action: "opened",
  number: 42,
  installation: { id: 1001 },
  repository: { name: "demo", owner: { login: "acme" } },
  pull_request: { head: { sha: "abc123" } },
});

// A valid installation.created payload
const INSTALL_PAYLOAD = JSON.stringify({
  action: "created",
  installation: {
    id: 2001,
    account: { login: "acme" },
  },
  repositories: [{ name: "repo1" }],
});

// A valid installation_repositories.added payload
const REPOS_ADDED_PAYLOAD = JSON.stringify({
  action: "added",
  installation: {
    id: 2001,
    account: { login: "acme" },
  },
  repositories_added: [{ name: "repo2" }],
});

// A valid issue_comment.created payload
const ISSUE_COMMENT_PAYLOAD = JSON.stringify({
  action: "created",
  installation: { id: 3001 },
  repository: { name: "repo3", owner: { login: "acme" } },
  issue: { number: 7 },
  comment: {
    id: 9001,
    html_url: "https://github.com/acme/repo3/issues/7#comment-9001",
    body: "Hello from partner",
    user: { login: "partner-user", type: "User" },
  },
});

// Bypass gate decision (legacy partner — no debit needed)
const BYPASS_GATE: { kind: "bypass"; installationRowId: string } = {
  kind: "bypass",
  installationRowId: "install-row-1",
};

// Debit gate decision
const DEBIT_GATE = {
  kind: "debit" as const,
  installationRowId: "install-row-2",
  channelId: "channel-1",
  balanceUsdc: "1.000000",
  priceUsdc: "0.500000",
  walletAddress: "0xabcdef",
};

// ---------------------------------------------------------------------------
// beforeEach: establish sane defaults for the happy path so individual tests
// only need to override what they care about.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset call records without wiping mock implementations from vi.hoisted.
  vi.clearAllMocks();
  // Reset the captured after() callback from the previous test.
  afterState.callback = null;
  // Re-register the after() implementation (clearAllMocks wipes it).
  nextServerMocks.after.mockImplementation((fn: () => Promise<void>) => {
    afterState.callback = fn;
  });

  process.env["GITHUB_APP_WEBHOOK_SECRET"] = WEBHOOK_SECRET;

  // verifyGitHubSignature mirrors the real HMAC comparison by default.
  signatureMocks.verifyGitHubSignature.mockImplementation(
    (rawBody: string, sig: string | null, secret: string) => {
      if (sig === null) return false;
      const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
      return sig === expected;
    },
  );

  githubAppMocks.getInstallationToken.mockResolvedValue("ghs_test_token");
  repoVisibilityMocks.isPublicRepo.mockResolvedValue(false);
  repoBenchmarkMocks.isBenchmarkRepo.mockResolvedValue(false);

  dbQueriesMocks.hashRepo.mockReturnValue("repo-hash-abc");
  dbQueriesMocks.enqueueReview.mockResolvedValue({ reviewId: "review-1", isNew: true });
  dbQueriesMocks.markReviewTerminallyFailed.mockResolvedValue(undefined);
  dbQueriesMocks.upsertInstallEntry.mockResolvedValue("approved");
  // Step 0.5 — dismiss ingestion defaults: precision flag OFF, autoretract
  // flag OFF so all pre-existing issue_comment tests are unaffected.
  precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(false);
  precisionFeedbackMocks.isPrecisionAutoRetractEnabled.mockReturnValue(false);
  dbQueriesMocks.lookupFindingForInstall.mockResolvedValue(null);
  dbQueriesMocks.recordMaintainerReactions.mockResolvedValue(1);
  dbQueriesMocks.retractFindingByDismiss.mockResolvedValue(true);

  gateMocks.decideGate.mockResolvedValue(BYPASS_GATE);
  gateMocks.debitForReview.mockResolvedValue({
    ok: true,
    debitedUsdc: "0.500000",
    newBalanceUsdc: "0.500000",
  });

  reviewWorkerMocks.runReviewWorker.mockResolvedValue({ kind: "completed" });
  onboarderMocks.runWelcomeOnInstall.mockResolvedValue(undefined);
  onboarderMocks.isWelcomeIssue.mockResolvedValue(false);
  onboarderMocks.recordPartnerReply.mockResolvedValue(undefined);

  invoiceMocks.buildInvoice.mockReturnValue({ topUpUsdc: "0.5", depositAddress: "0xdead" });
  invoiceMocks.renderInvoiceComment.mockReturnValue("invoice body");
  paywallEnvMocks.getDepositAddress.mockReturnValue("0xdeadbeef");
});

afterEach(() => {
  delete process.env["GITHUB_APP_WEBHOOK_SECRET"];
});

// ===========================================================================
// (a) Signature validation
// ===========================================================================

describe("signature validation", () => {
  it("returns 500 when GITHUB_APP_WEBHOOK_SECRET is not set", async () => {
    delete process.env["GITHUB_APP_WEBHOOK_SECRET"];
    const res = await POST(makeRequest("{}", { event: "ping" }));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("server misconfigured");
  });

  it("returns 401 when signature header is missing", async () => {
    signatureMocks.verifyGitHubSignature.mockReturnValue(false);
    const res = await POST(makeRequest("{}", { signature: null, event: "ping" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("invalid signature");
  });

  it("returns 401 when signature is wrong", async () => {
    signatureMocks.verifyGitHubSignature.mockReturnValue(false);
    const res = await POST(
      makeRequest("{}", {
        signature: "sha256=" + "0".repeat(64),
        event: "ping",
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("invalid signature");
  });

  it("returns 400 when body is not valid JSON (signature passes)", async () => {
    const malformed = "not-json";
    signatureMocks.verifyGitHubSignature.mockReturnValue(true);
    const res = await POST(
      makeRequest(malformed, {
        signature: makeHmac(malformed),
        event: "ping",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid json");
  });

  it("proceeds past signature check for a correctly HMAC-signed body", async () => {
    // A ping event (no action) is a no-op but should return 200 ok.
    const body = JSON.stringify({ zen: "design for failure" });
    const res = await POST(
      makeRequest(body, {
        signature: makeHmac(body),
        event: "ping",
      }),
    );
    // No matching event handler — falls through to the final ok: true.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });
});

// ===========================================================================
// (b) Parser safety — malformed payloads must return safe null/[] not throw
// ===========================================================================

describe("installCreatedTargets parser safety", () => {
  it("returns ok:true for installation.created with totally missing fields", async () => {
    const body = JSON.stringify({ action: "created" });
    const res = await POST(makeRequest(body, { event: "installation", signature: makeHmac(body) }));
    // Parser returns [] → no after() spawn, but route still returns 200.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });

  it("returns ok:true when installation.id is a string instead of number", async () => {
    const body = JSON.stringify({
      action: "created",
      installation: { id: "not-a-number", account: { login: "acme" } },
      repositories: [{ name: "repo" }],
    });
    const res = await POST(makeRequest(body, { event: "installation", signature: makeHmac(body) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });

  it("returns ok:true when repositories array entry is missing name field", async () => {
    const body = JSON.stringify({
      action: "created",
      installation: { id: 1001, account: { login: "acme" } },
      repositories: [{ id: 999 }], // no name
    });
    const res = await POST(makeRequest(body, { event: "installation", signature: makeHmac(body) }));
    // Parser yields [] because no repo name — still ok.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });

  it("returns ok:true when payload is null (parser guard fires)", async () => {
    // verifyGitHubSignature passes; JSON.parse("null") === null.
    const body = "null";
    signatureMocks.verifyGitHubSignature.mockReturnValue(true);
    const res = await POST(makeRequest(body, { event: "installation", signature: makeHmac(body) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });
});

describe("repositoriesAddedTargets parser safety", () => {
  it("returns ok:true for installation_repositories.added with missing fields", async () => {
    const body = JSON.stringify({ action: "added" });
    const res = await POST(
      makeRequest(body, {
        event: "installation_repositories",
        signature: makeHmac(body),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });

  it("returns ok:true when repositories_added is not an array", async () => {
    const body = JSON.stringify({
      action: "added",
      installation: { id: 2001, account: { login: "acme" } },
      repositories_added: "not-an-array",
    });
    const res = await POST(
      makeRequest(body, {
        event: "installation_repositories",
        signature: makeHmac(body),
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });
});

describe("asIssueCommentPayload parser safety", () => {
  it("returns ok:true for issue_comment.created with missing comment fields", async () => {
    const body = JSON.stringify({ action: "created" });
    const res = await POST(
      makeRequest(body, { event: "issue_comment", signature: makeHmac(body) }),
    );
    // Parser returns null → ic is null → no after() dispatch.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });

  it("returns ok:true when comment.id is a string instead of number", async () => {
    const body = JSON.stringify({
      action: "created",
      installation: { id: 3001 },
      repository: { name: "repo", owner: { login: "acme" } },
      issue: { number: 5 },
      comment: {
        id: "not-a-number", // wrong type
        html_url: "https://github.com/acme/repo/issues/5#comment-1",
        body: "hi",
        user: { login: "partner", type: "User" },
      },
    });
    const res = await POST(
      makeRequest(body, { event: "issue_comment", signature: makeHmac(body) }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });
});

describe("asPullRequestPayload parser safety", () => {
  it("returns ok:true for pull_request.opened with missing number field", async () => {
    const body = JSON.stringify({
      action: "opened",
      // number is missing
      installation: { id: 1001 },
      repository: { name: "demo", owner: { login: "acme" } },
      pull_request: { head: { sha: "abc123" } },
    });
    const res = await POST(makeRequest(body, { event: "pull_request", signature: makeHmac(body) }));
    // Parser returns null → route logs dispatch_skipped, returns ok: true.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });

  it("returns ok:true when pull_request.head.sha is missing", async () => {
    const body = JSON.stringify({
      action: "opened",
      number: 42,
      installation: { id: 1001 },
      repository: { name: "demo", owner: { login: "acme" } },
      pull_request: { head: {} }, // no sha
    });
    const res = await POST(makeRequest(body, { event: "pull_request", signature: makeHmac(body) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
  });

  it("returns ok:true for an unrecognised action (e.g. closed)", async () => {
    const body = JSON.stringify({
      action: "closed",
      number: 42,
      installation: { id: 1001 },
      repository: { name: "demo", owner: { login: "acme" } },
      pull_request: { head: { sha: "abc123" } },
    });
    const res = await POST(makeRequest(body, { event: "pull_request", signature: makeHmac(body) }));
    // DISPATCH_ACTIONS doesn't contain "closed" → early return ok: true.
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
    // Should not have touched enqueueReview at all.
    expect(dbQueriesMocks.enqueueReview).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// (c) Billing ordering invariant
// ===========================================================================

describe("billing ordering invariant", () => {
  function makePrRequest(body = PR_PAYLOAD): NextRequest {
    return makeRequest(body, {
      event: "pull_request",
      delivery: "delivery-001",
    });
  }

  it("calls debitForReview only AFTER enqueueReview returns isNew=true", async () => {
    const callOrder: string[] = [];

    dbQueriesMocks.enqueueReview.mockImplementation(async () => {
      callOrder.push("enqueueReview");
      return { reviewId: "review-1", isNew: true };
    });

    gateMocks.decideGate.mockResolvedValue(DEBIT_GATE);
    gateMocks.debitForReview.mockImplementation(async () => {
      callOrder.push("debitForReview");
      return { ok: true, debitedUsdc: "0.500000", newBalanceUsdc: "0.500000" };
    });

    const res = await POST(makePrRequest());
    expect(res.status).toBe(200);

    // Both must have been called...
    expect(callOrder).toContain("enqueueReview");
    expect(callOrder).toContain("debitForReview");

    // ...and enqueueReview must precede debitForReview.
    expect(callOrder.indexOf("enqueueReview")).toBeLessThan(callOrder.indexOf("debitForReview"));
  });

  it("does NOT call debitForReview when enqueueReview returns isNew=false (duplicate delivery)", async () => {
    // Simulate a duplicate delivery: same (repo, pr, sha) already enqueued.
    dbQueriesMocks.enqueueReview.mockResolvedValue({ reviewId: "review-1", isNew: false });
    gateMocks.decideGate.mockResolvedValue(DEBIT_GATE);

    const res = await POST(makePrRequest());
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["duplicate"]).toBe(true);

    // The cardinal rule: no debit on a duplicate.
    expect(gateMocks.debitForReview).not.toHaveBeenCalled();
  });

  it("regression: moving debitForReview before isNew check would make this test fail", async () => {
    // This test documents the INVARIANT. If someone changes the route so
    // debitForReview is called unconditionally (before the isNew guard),
    // debitForReview would be called even when isNew=false. This test MUST
    // remain red if that change is introduced.
    dbQueriesMocks.enqueueReview.mockResolvedValue({ reviewId: "review-dup", isNew: false });
    gateMocks.decideGate.mockResolvedValue(DEBIT_GATE);

    await POST(makePrRequest());

    // Assert the invariant: debitForReview must NOT be called for duplicate.
    expect(gateMocks.debitForReview).not.toHaveBeenCalled();
  });

  it("does not double-debit on two sequential duplicate deliveries", async () => {
    gateMocks.decideGate.mockResolvedValue(DEBIT_GATE);

    // First delivery: isNew=true → debit fires once.
    dbQueriesMocks.enqueueReview.mockResolvedValueOnce({ reviewId: "review-1", isNew: true });
    const first = await POST(makePrRequest());
    expect(first.status).toBe(200);
    expect(gateMocks.debitForReview).toHaveBeenCalledTimes(1);

    // Second delivery with same body: isNew=false → no debit.
    dbQueriesMocks.enqueueReview.mockResolvedValueOnce({ reviewId: "review-1", isNew: false });
    const second = await POST(makePrRequest());
    expect(second.status).toBe(200);
    const json2 = (await second.json()) as Record<string, unknown>;
    expect(json2["duplicate"]).toBe(true);

    // Still only called once from the first delivery.
    expect(gateMocks.debitForReview).toHaveBeenCalledTimes(1);
  });

  it("skips debitForReview entirely when gate decision is bypass", async () => {
    gateMocks.decideGate.mockResolvedValue(BYPASS_GATE);
    dbQueriesMocks.enqueueReview.mockResolvedValue({ reviewId: "review-bypass", isNew: true });

    const res = await POST(makePrRequest());
    expect(res.status).toBe(200);

    // bypass path never calls debitForReview.
    expect(gateMocks.debitForReview).not.toHaveBeenCalled();
  });

  it("skips debitForReview when gate decision is not_installed", async () => {
    gateMocks.decideGate.mockResolvedValue({ kind: "not_installed" });

    const res = await POST(makePrRequest());
    expect(res.status).toBe(200);

    expect(gateMocks.debitForReview).not.toHaveBeenCalled();
    expect(dbQueriesMocks.enqueueReview).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Happy-path smoke test: full pull_request flow returns reviewId
// ===========================================================================

describe("pull_request happy path", () => {
  it("returns ok:true and reviewId for a valid opened event", async () => {
    gateMocks.decideGate.mockResolvedValue(BYPASS_GATE);
    dbQueriesMocks.enqueueReview.mockResolvedValue({ reviewId: "review-99", isNew: true });

    const res = await POST(
      makeRequest(PR_PAYLOAD, {
        event: "pull_request",
        delivery: "delivery-happy",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);
    expect(json["reviewId"]).toBe("review-99");
  });

  it("schedules background worker via after() on a new review", async () => {
    gateMocks.decideGate.mockResolvedValue(BYPASS_GATE);
    dbQueriesMocks.enqueueReview.mockResolvedValue({ reviewId: "review-worker", isNew: true });

    await POST(
      makeRequest(PR_PAYLOAD, {
        event: "pull_request",
        delivery: "delivery-worker",
      }),
    );

    expect(nextServerMocks.after).toHaveBeenCalledTimes(1);

    // Flush the after() callback to verify it runs the review worker.
    await nextServerMocks.flushAfter();
    expect(reviewWorkerMocks.runReviewWorker).toHaveBeenCalledWith("review-worker", "webhook");
  });

  it("does NOT schedule worker when review is a duplicate", async () => {
    gateMocks.decideGate.mockResolvedValue(BYPASS_GATE);
    dbQueriesMocks.enqueueReview.mockResolvedValue({ reviewId: "review-dup", isNew: false });

    await POST(
      makeRequest(PR_PAYLOAD, {
        event: "pull_request",
        delivery: "delivery-dup",
      }),
    );

    // after() must not be called for duplicate deliveries.
    expect(nextServerMocks.after).not.toHaveBeenCalled();
    expect(reviewWorkerMocks.runReviewWorker).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// installation.created — smoke test for onboarding path
// ===========================================================================

describe("installation.created", () => {
  it("returns ok:true and triggers upsertInstallEntry via after()", async () => {
    dbQueriesMocks.upsertInstallEntry.mockResolvedValue("approved");

    const res = await POST(
      makeRequest(INSTALL_PAYLOAD, {
        event: "installation",
        delivery: "delivery-install",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);

    // Flush after() — should call upsertInstallEntry then runWelcomeOnInstall.
    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.upsertInstallEntry).toHaveBeenCalledWith(2001, "acme", "repo1");
    expect(onboarderMocks.runWelcomeOnInstall).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 2001, owner: "acme", repo: "repo1" }),
    );
  });
});

// ===========================================================================
// installation_repositories.added — smoke test
// ===========================================================================

describe("installation_repositories.added", () => {
  it("returns ok:true for valid repos_added payload", async () => {
    const res = await POST(
      makeRequest(REPOS_ADDED_PAYLOAD, {
        event: "installation_repositories",
        delivery: "delivery-repos",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["ok"]).toBe(true);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.upsertInstallEntry).toHaveBeenCalledWith(2001, "acme", "repo2");
  });
});

// ===========================================================================
// issue_comment.created — smoke test for partner-reply path
// ===========================================================================

describe("issue_comment.created", () => {
  it("dispatches recordPartnerReply for a welcome-issue comment", async () => {
    onboarderMocks.isWelcomeIssue.mockResolvedValue(true);

    const res = await POST(
      makeRequest(ISSUE_COMMENT_PAYLOAD, {
        event: "issue_comment",
        delivery: "delivery-comment",
      }),
    );
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(onboarderMocks.isWelcomeIssue).toHaveBeenCalledWith(3001, "acme", "repo3", 7);
    expect(onboarderMocks.recordPartnerReply).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 3001,
        owner: "acme",
        repo: "repo3",
        issueNumber: 7,
        commentId: 9001,
        senderLogin: "partner-user",
      }),
    );
  });

  it("does not dispatch recordPartnerReply when isWelcomeIssue returns false", async () => {
    onboarderMocks.isWelcomeIssue.mockResolvedValue(false);

    const res = await POST(
      makeRequest(ISSUE_COMMENT_PAYLOAD, {
        event: "issue_comment",
        delivery: "delivery-non-welcome",
      }),
    );
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(onboarderMocks.recordPartnerReply).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// (d) parseDismissCommand — unit tests for the dismiss parser
// ===========================================================================

describe("parseDismissCommand", () => {
  const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
  const VALID_ID = `${VALID_UUID}-0`;

  it("returns null on empty body", () => {
    expect(parseDismissCommand("")).toBeNull();
  });

  it("returns null for unrelated comment", () => {
    expect(parseDismissCommand("Looks good to me!")).toBeNull();
  });

  it("returns null for other bot mentions", () => {
    expect(parseDismissCommand("@coderabbit dismiss something")).toBeNull();
  });

  it("returns null when findingId is not UUID-prefixed", () => {
    expect(parseDismissCommand("@antfleet dismiss abc-123")).toBeNull();
    expect(parseDismissCommand("@antfleet dismiss shortid-0")).toBeNull();
  });

  it("parses a bare dismiss with no reason", () => {
    const result = parseDismissCommand(`@antfleet dismiss ${VALID_ID}`);
    expect(result).not.toBeNull();
    expect(result?.findingId).toBe(VALID_ID);
    expect(result?.reason).toBeNull();
  });

  it("parses a dismiss with a reason", () => {
    const result = parseDismissCommand(`@antfleet dismiss ${VALID_ID} not a real issue`);
    expect(result).not.toBeNull();
    expect(result?.findingId).toBe(VALID_ID);
    expect(result?.reason).toBe("not a real issue");
  });

  it("is case-insensitive on the 'dismiss' keyword", () => {
    const result = parseDismissCommand(`@antfleet Dismiss ${VALID_ID}`);
    expect(result).not.toBeNull();
    expect(result?.findingId).toBe(VALID_ID);
  });

  it("tolerates leading/trailing whitespace on the line", () => {
    const result = parseDismissCommand(`  @antfleet dismiss ${VALID_ID}  `);
    expect(result).not.toBeNull();
    expect(result?.findingId).toBe(VALID_ID);
  });

  it("matches when the dismiss command appears on a non-first line", () => {
    const body = `Thanks for the review.\n@antfleet dismiss ${VALID_ID} false positive`;
    const result = parseDismissCommand(body);
    expect(result).not.toBeNull();
    expect(result?.findingId).toBe(VALID_ID);
    expect(result?.reason).toBe("false positive");
  });

  it("supports finding index > 0", () => {
    const id = `${VALID_UUID}-12`;
    const result = parseDismissCommand(`@antfleet dismiss ${id}`);
    expect(result?.findingId).toBe(id);
  });
});

// ===========================================================================
// (e) Dismiss ingestion — issue_comment.created with dismiss command
// ===========================================================================

// A shared UUID + finding-id for the dismiss tests.
const DISMISS_REVIEW_ID = "550e8400-e29b-41d4-a716-446655440001";
const DISMISS_FINDING_ID = `${DISMISS_REVIEW_ID}-0`;

function makeDismissCommentPayload(
  opts: {
    senderLogin?: string;
    senderType?: string;
    authorAssociation?: string;
    body?: string;
    createdAt?: string;
  } = {},
): string {
  return JSON.stringify({
    action: "created",
    installation: { id: 4001 },
    repository: { name: "repo4", owner: { login: "acme" } },
    issue: { number: 10 },
    comment: {
      id: 9002,
      html_url: "https://github.com/acme/repo4/issues/10#comment-9002",
      body: opts.body ?? `@antfleet dismiss ${DISMISS_FINDING_ID} not a real issue`,
      user: {
        login: opts.senderLogin ?? "maintainer-alice",
        type: opts.senderType ?? "User",
      },
      author_association: opts.authorAssociation ?? "MEMBER",
      created_at: opts.createdAt ?? "2026-07-07T10:00:00Z",
    },
  });
}

describe("dismiss ingestion — issue_comment.created", () => {
  it("records a maintainer_reactions row when flag ON and MEMBER association", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload();
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.recordMaintainerReactions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          reviewId: DISMISS_REVIEW_ID,
          findingId: DISMISS_FINDING_ID,
          actionTaken: "dismiss:reply",
          reactorLogin: "maintainer-alice",
          authorAssociation: "MEMBER",
          maintainerComment: "not a real issue",
        }),
      ]),
    );
  });

  it("records with OWNER association", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload({ authorAssociation: "OWNER" });
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.recordMaintainerReactions).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ authorAssociation: "OWNER" })]),
    );
  });

  it("does NOT record when flag is OFF (default)", async () => {
    // precisionFeedbackMocks returns false by default from beforeEach.
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload();
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.recordMaintainerReactions).not.toHaveBeenCalled();
  });

  it("does NOT record when author_association is NONE (not a maintainer)", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload({ authorAssociation: "NONE" });
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.recordMaintainerReactions).not.toHaveBeenCalled();
  });

  it("does NOT record when author_association is CONTRIBUTOR", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload({ authorAssociation: "CONTRIBUTOR" });
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.recordMaintainerReactions).not.toHaveBeenCalled();
  });

  it("does NOT record when findingId not found in this install", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    // lookupFindingForInstall returns null — id belongs to a different install or doesn't exist.
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue(null);

    const body = makeDismissCommentPayload();
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.recordMaintainerReactions).not.toHaveBeenCalled();
  });

  it("does NOT process dismiss when sender is antfleet[bot]", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload({ senderLogin: "antfleet[bot]", senderType: "Bot" });
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    // The route filters sender != antfleet[bot] before spawning after(),
    // so the dismiss path is never reached.
    expect(dbQueriesMocks.recordMaintainerReactions).not.toHaveBeenCalled();
    expect(precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall).not.toHaveBeenCalled();
  });

  it("does NOT call recordMaintainerReactions when comment body has no dismiss command", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload({ body: "LGTM, merging." });
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    // No dismiss command → lookupFindingForInstall never called, no reaction recorded.
    expect(dbQueriesMocks.lookupFindingForInstall).not.toHaveBeenCalled();
    expect(dbQueriesMocks.recordMaintainerReactions).not.toHaveBeenCalled();
  });

  it("partner-reply still fires alongside dismiss when isWelcomeIssue is true", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    onboarderMocks.isWelcomeIssue.mockResolvedValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });

    const body = makeDismissCommentPayload();
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    // Both paths should fire independently.
    expect(onboarderMocks.recordPartnerReply).toHaveBeenCalledTimes(1);
    expect(dbQueriesMocks.recordMaintainerReactions).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// (f) Auto-retraction — item 6
// ===========================================================================

describe("auto-retraction on dismiss (item 6)", () => {
  it("does NOT retract when AUTORETRACT flag is OFF (default)", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    precisionFeedbackMocks.isPrecisionAutoRetractEnabled.mockReturnValue(false);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });
    dbQueriesMocks.recordMaintainerReactions.mockResolvedValue(1);

    const body = makeDismissCommentPayload();
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.recordMaintainerReactions).toHaveBeenCalledTimes(1);
    // Auto-retraction must NOT fire when sub-flag is OFF.
    expect(dbQueriesMocks.retractFindingByDismiss).not.toHaveBeenCalled();
  });

  it("retracts when AUTORETRACT flag is ON and dismiss is newly inserted", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    precisionFeedbackMocks.isPrecisionAutoRetractEnabled.mockReturnValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });
    // inserted=1 → new dismiss row
    dbQueriesMocks.recordMaintainerReactions.mockResolvedValue(1);
    dbQueriesMocks.retractFindingByDismiss.mockResolvedValue(true);

    const body = makeDismissCommentPayload();
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.retractFindingByDismiss).toHaveBeenCalledWith(
      DISMISS_FINDING_ID,
      "not a real issue",
    );
  });

  it("does NOT retract when dismiss is a duplicate (inserted=0 from dedup)", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    precisionFeedbackMocks.isPrecisionAutoRetractEnabled.mockReturnValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });
    // inserted=0 → duplicate, dedup suppressed it
    dbQueriesMocks.recordMaintainerReactions.mockResolvedValue(0);

    const body = makeDismissCommentPayload();
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    // Dedup means inserted=0 → auto-retraction is skipped (idempotency guard).
    expect(dbQueriesMocks.retractFindingByDismiss).not.toHaveBeenCalled();
  });

  it("retractFindingByDismiss called with null reason when no reason given", async () => {
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    precisionFeedbackMocks.isPrecisionAutoRetractEnabled.mockReturnValue(true);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });
    dbQueriesMocks.recordMaintainerReactions.mockResolvedValue(1);

    // bare dismiss with no reason
    const body = makeDismissCommentPayload({
      body: `@antfleet dismiss ${DISMISS_FINDING_ID}`,
    });
    const res = await POST(makeRequest(body, { event: "issue_comment" }));
    expect(res.status).toBe(200);

    await nextServerMocks.flushAfter();
    expect(dbQueriesMocks.retractFindingByDismiss).toHaveBeenCalledWith(
      DISMISS_FINDING_ID,
      null, // no reason in command
    );
  });

  it("capture still works with precision flag ON but AUTORETRACT OFF", async () => {
    // This verifies the canary pattern: precision flag ON (capture enabled)
    // but autoretract OFF (no public receipt mutation).
    precisionFeedbackMocks.isPrecisionFeedbackEnabledForInstall.mockResolvedValue(true);
    precisionFeedbackMocks.isPrecisionAutoRetractEnabled.mockReturnValue(false);
    dbQueriesMocks.lookupFindingForInstall.mockResolvedValue({ reviewId: DISMISS_REVIEW_ID });
    dbQueriesMocks.recordMaintainerReactions.mockResolvedValue(1);

    const body = makeDismissCommentPayload();
    await POST(makeRequest(body, { event: "issue_comment" }));
    await nextServerMocks.flushAfter();

    // Signal captured...
    expect(dbQueriesMocks.recordMaintainerReactions).toHaveBeenCalledTimes(1);
    // ...but no retraction.
    expect(dbQueriesMocks.retractFindingByDismiss).not.toHaveBeenCalled();
  });
});
