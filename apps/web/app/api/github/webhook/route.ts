import type { NextRequest } from "next/server";
import { NextResponse, after } from "next/server";
import { Octokit } from "@octokit/rest";
import { verifyGitHubSignature } from "@/lib/github-signature";
import { getInstallationToken } from "@/lib/github-app";
import { isPublicRepo } from "@/lib/repo-visibility";
import { isBenchmarkRepo } from "@/lib/repo-benchmark";
import { getRepoCyberTier } from "@/lib/cyber-tier";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { isWelcomeIssue, recordPartnerReply, runWelcomeOnInstall } from "@/lib/onboarder";
import { runReviewWorker } from "@/lib/review-worker";
import {
  enqueueReview,
  hashRepo,
  lookupFindingForInstall,
  markReviewTerminallyFailed,
  recordMaintainerReactions,
  retractFindingByDismiss,
  upsertInstallEntry,
} from "@/db/queries";
import {
  isPrecisionAutoRetractEnabled,
  isPrecisionFeedbackEnabledForInstall,
} from "@/lib/precision-feedback-env";
import { db } from "@/db";
import { debitForReview, decideGate, type GateDecision } from "@/lib/paywall/gate";
import { buildInvoice, renderInvoiceComment } from "@/lib/paywall/invoice";
import { getDepositAddress } from "@/lib/paywall/env";

// node:crypto is Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";

// Pro plan ceiling — 300s. The review work itself happens inside
// after(); we still pin maxDuration here so the worker (now extracted
// into lib/review-worker.ts) has the full 300s window for its first
// attempt. The retry cron at /api/cron/review-retry picks up anything
// the webhook's after() couldn't finish.
export const maxDuration = 300;

const DISPATCH_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

type PullRequestPayload = {
  action: string;
  number: number;
  installation: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: { head: { sha: string } };
};

type InstallTarget = {
  installationId: number;
  owner: string;
  repo: string;
};

// installation.created payload shape — the `repositories` array carries
// the repos that arrived with the install (could be one or many). Owner
// of each is the installation account; we extract via `account.login`.
function installCreatedTargets(raw: unknown): InstallTarget[] {
  if (typeof raw !== "object" || raw === null) return [];
  const p = raw as Record<string, unknown>;
  const installation = p["installation"] as Record<string, unknown> | undefined;
  const installationId = installation?.["id"];
  const account = installation?.["account"] as Record<string, unknown> | undefined;
  const ownerLogin = account?.["login"];
  const repositories = Array.isArray(p["repositories"])
    ? (p["repositories"] as Array<Record<string, unknown>>)
    : [];
  if (typeof installationId !== "number" || typeof ownerLogin !== "string") return [];
  const out: InstallTarget[] = [];
  for (const r of repositories) {
    if (typeof r["name"] === "string") {
      out.push({ installationId, owner: ownerLogin, repo: r["name"] });
    }
  }
  return out;
}

type IssueCommentPayload = {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  commentId: number;
  commentUrl: string;
  body: string;
  sender: { login: string; type: string };
  // Step 0.5 — dismiss signal ingestion. GitHub's author_association on the
  // comment object (not the issue author). Defaults to "NONE" when the field
  // is absent — this is the safe, least-permissive fallback. Captured here
  // so the handler can gate on OWNER/MEMBER/COLLABORATOR without a second
  // API call. commentCreatedAt is used as reactionAt for the
  // maintainer_reactions row.
  authorAssociation: string;
  commentCreatedAt: Date;
};

// issue_comment.created payload shape — `comment.user` is the author of
// the comment; `issue.number` is the target issue; `repository.owner.login`
// + `repository.name` and `installation.id` give us the auth context.
function asIssueCommentPayload(raw: unknown): IssueCommentPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const installation = p["installation"] as Record<string, unknown> | undefined;
  const installationId = installation?.["id"];
  const repository = p["repository"] as Record<string, unknown> | undefined;
  const owner = repository?.["owner"] as Record<string, unknown> | undefined;
  const issue = p["issue"] as Record<string, unknown> | undefined;
  const comment = p["comment"] as Record<string, unknown> | undefined;
  const sender = (comment?.["user"] ?? p["sender"]) as Record<string, unknown> | undefined;
  if (
    typeof installationId !== "number" ||
    typeof repository?.["name"] !== "string" ||
    typeof owner?.["login"] !== "string" ||
    typeof issue?.["number"] !== "number" ||
    typeof comment?.["id"] !== "number" ||
    typeof comment?.["html_url"] !== "string" ||
    typeof comment?.["body"] !== "string" ||
    typeof sender?.["login"] !== "string" ||
    typeof sender?.["type"] !== "string"
  ) {
    return null;
  }
  // author_association is present on the comment object (e.g. "OWNER",
  // "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"). Fall back to "NONE"
  // when absent so the dismiss gate defaults to deny.
  const authorAssociation =
    typeof comment["author_association"] === "string" ? comment["author_association"] : "NONE";
  // created_at is an ISO 8601 timestamp string. Fall back to now so a
  // missing field doesn't block recording; the dedup key is (reviewId,
  // findingId, reactionAt, actionTaken) so a wrong timestamp at most
  // creates a duplicate row on re-delivery.
  const createdAtRaw = comment["created_at"];
  const commentCreatedAt = typeof createdAtRaw === "string" ? new Date(createdAtRaw) : new Date();
  return {
    installationId,
    owner: owner["login"],
    repo: repository["name"],
    issueNumber: issue["number"],
    commentId: comment["id"],
    commentUrl: comment["html_url"],
    body: comment["body"],
    sender: { login: sender["login"], type: sender["type"] },
    authorAssociation,
    commentCreatedAt,
  };
}

// Step 0.5 — dismiss command parser.
//
// Matches any line of the form (case-insensitive on "dismiss"):
//   @antfleet dismiss <finding-id> [optional reason...]
//
// finding-id must match the canonical shape: <UUID>-<digits>, where UUID
// is the standard 8-4-4-4-12 hex format. Any other shape (malformed UUID,
// wrong keyword, wrong mention) returns null so unrelated comments are
// silently ignored.
//
// Exported for unit tests; production callers import from this module.
const CANONICAL_FINDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d+$/i;

export function parseDismissCommand(
  body: string,
): { findingId: string; reason: string | null } | null {
  // `im` flags: case-insensitive (tolerate "Dismiss"), multiline (match any line).
  const m = /^[ \t]*@antfleet[ \t]+dismiss[ \t]+(\S+)(?:[ \t]+(.*\S))?[ \t]*$/im.exec(body);
  if (m === null) return null;
  const candidateId = m[1] ?? "";
  if (!CANONICAL_FINDING_ID_RE.test(candidateId)) return null;
  const reason = m[2] !== undefined && m[2].length > 0 ? m[2] : null;
  return { findingId: candidateId, reason };
}

const DISMISS_ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// installation_repositories.added — fired when an existing install
// broadens to include new repos. The `repositories_added` array
// names them.
function repositoriesAddedTargets(raw: unknown): InstallTarget[] {
  if (typeof raw !== "object" || raw === null) return [];
  const p = raw as Record<string, unknown>;
  const installation = p["installation"] as Record<string, unknown> | undefined;
  const installationId = installation?.["id"];
  const account = installation?.["account"] as Record<string, unknown> | undefined;
  const ownerLogin = account?.["login"];
  const repositoriesAdded = Array.isArray(p["repositories_added"])
    ? (p["repositories_added"] as Array<Record<string, unknown>>)
    : [];
  if (typeof installationId !== "number" || typeof ownerLogin !== "string") return [];
  const out: InstallTarget[] = [];
  for (const r of repositoriesAdded) {
    if (typeof r["name"] === "string") {
      out.push({ installationId, owner: ownerLogin, repo: r["name"] });
    }
  }
  return out;
}

function asPullRequestPayload(raw: unknown): PullRequestPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const installation = p["installation"] as Record<string, unknown> | undefined;
  const repository = p["repository"] as Record<string, unknown> | undefined;
  const owner = repository?.["owner"] as Record<string, unknown> | undefined;
  const pull_request = p["pull_request"] as Record<string, unknown> | undefined;
  const head = pull_request?.["head"] as Record<string, unknown> | undefined;
  if (
    typeof p["action"] !== "string" ||
    typeof p["number"] !== "number" ||
    typeof installation?.["id"] !== "number" ||
    typeof repository?.["name"] !== "string" ||
    typeof owner?.["login"] !== "string" ||
    typeof head?.["sha"] !== "string"
  ) {
    return null;
  }
  return {
    action: p["action"],
    number: p["number"],
    installation: { id: installation["id"] },
    repository: { name: repository["name"], owner: { login: owner["login"] } },
    pull_request: { head: { sha: head["sha"] } },
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
  if (secret === undefined || secret.length === 0) {
    logError("webhook.misconfigured", { reason: "GITHUB_APP_WEBHOOK_SECRET missing" });
    return new NextResponse("server misconfigured", { status: 500 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  const delivery = req.headers.get("x-github-delivery");
  const githubEvent = req.headers.get("x-github-event");

  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    logWarn("webhook.signature_invalid", { delivery, githubEvent });
    return new NextResponse("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    logWarn("webhook.payload_unparseable", { delivery, githubEvent });
    return new NextResponse("invalid json", { status: 400 });
  }

  const action =
    typeof payload === "object" && payload !== null && "action" in payload
      ? String((payload as { action: unknown }).action)
      : null;

  logInfo("webhook.received", { delivery, githubEvent, action });

  // Onboarder install-welcome dispatch. Handled separately from PR
  // events because the payload shape differs and the signal we care
  // about (a freshly-installed repo) lives on the `installation` and
  // `installation_repositories` events, not on `pull_request`. The
  // agent itself self-gates on ONBOARDER_ENABLED — but we still parse
  // the payload here so we can log "we saw the install" regardless.
  if (githubEvent === "installation" && action === "created") {
    const welcomes = installCreatedTargets(payload);
    logInfo("webhook.install_created", {
      delivery,
      installationId: welcomes[0]?.installationId ?? null,
      repoCount: welcomes.length,
    });
    if (welcomes.length > 0) {
      after(async () => {
        for (const w of welcomes) {
          try {
            const status = await upsertInstallEntry(w.installationId, w.owner, w.repo);
            if (status === "approved") {
              await runWelcomeOnInstall(w);
            } else {
              logInfo("webhook.install_pending_approval", {
                delivery,
                installationId: w.installationId,
                owner: w.owner,
                repo: w.repo,
              });
            }
          } catch (err) {
            logError("webhook.install_upsert_failed", {
              delivery,
              installationId: w.installationId,
              owner: w.owner,
              repo: w.repo,
              message: messageOf(err),
            });
          }
        }
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (githubEvent === "installation_repositories" && action === "added") {
    const welcomes = repositoriesAddedTargets(payload);
    logInfo("webhook.installation_repositories_added", {
      delivery,
      installationId: welcomes[0]?.installationId ?? null,
      repoCount: welcomes.length,
    });
    if (welcomes.length > 0) {
      after(async () => {
        for (const w of welcomes) {
          try {
            const status = await upsertInstallEntry(w.installationId, w.owner, w.repo);
            if (status === "approved") {
              await runWelcomeOnInstall(w);
            } else {
              logInfo("webhook.install_pending_approval", {
                delivery,
                installationId: w.installationId,
                owner: w.owner,
                repo: w.repo,
              });
            }
          } catch (err) {
            logError("webhook.install_upsert_failed", {
              delivery,
              installationId: w.installationId,
              owner: w.owner,
              repo: w.repo,
              message: messageOf(err),
            });
          }
        }
      });
    }
    return NextResponse.json({ ok: true });
  }

  // Partner-reply signal capture. issue_comment.created fires for every
  // new comment on every issue/PR in every installed repo. Most of those
  // we don't care about; we only capture comments on our welcome issues.
  // Filter at three layers:
  //   1. Action == created (skip edited/deleted)
  //   2. Sender is not antfleet[bot] (skip our own posts — the
  //      first-review summary, check-ins, etc., all post via the App)
  //   3. The target issue is one of our welcome issues (DB lookup)
  // Step 0.5 adds a second path in the same after() block: dismiss command
  // ingestion, flag-gated on ANTFLEET_PRECISION_FEEDBACK.
  if (githubEvent === "issue_comment" && action === "created") {
    const ic = asIssueCommentPayload(payload);
    if (ic !== null && ic.sender.login !== "antfleet[bot]") {
      after(async () => {
        // Path 1: partner-reply recording (unchanged).
        try {
          const isWelcome = await isWelcomeIssue(
            ic.installationId,
            ic.owner,
            ic.repo,
            ic.issueNumber,
          );
          if (isWelcome) {
            await recordPartnerReply({
              installationId: ic.installationId,
              owner: ic.owner,
              repo: ic.repo,
              issueNumber: ic.issueNumber,
              commentId: ic.commentId,
              commentUrl: ic.commentUrl,
              body: ic.body,
              senderLogin: ic.sender.login,
              senderType: ic.sender.type,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError("webhook.partner_reply_dispatch_failed", { delivery, message });
        }

        // Path 2: dismiss command ingestion (Step 0.5, item 4).
        // Best-effort only — errors are logged but never surface to the caller.
        const dismissCmd = parseDismissCommand(ic.body);
        if (dismissCmd !== null) {
          try {
            const enabled = await isPrecisionFeedbackEnabledForInstall(ic.installationId, ic.repo);
            if (!enabled) return;

            if (!DISMISS_ALLOWED_ASSOCIATIONS.has(ic.authorAssociation)) {
              logInfo("webhook.dismiss_association_denied", {
                delivery,
                findingId: dismissCmd.findingId,
                authorAssociation: ic.authorAssociation,
              });
              return;
            }

            const found = await lookupFindingForInstall(
              dismissCmd.findingId,
              ic.installationId,
              ic.repo,
            );
            if (found === null) {
              logWarn("webhook.dismiss_finding_not_found", {
                delivery,
                findingId: dismissCmd.findingId,
              });
              return;
            }

            const inserted = await recordMaintainerReactions([
              {
                reviewId: found.reviewId,
                findingId: dismissCmd.findingId,
                actionTaken: "dismiss:reply",
                reactionAt: ic.commentCreatedAt,
                maintainerComment: dismissCmd.reason,
                reactorLogin: ic.sender.login,
                authorAssociation: ic.authorAssociation,
              },
            ]);
            logInfo("webhook.dismiss_recorded", {
              delivery,
              findingId: dismissCmd.findingId,
              reactorLogin: ic.sender.login,
              inserted,
            });

            // Auto-retraction (item 6): only when sub-flag is ON and the
            // dismiss row was newly inserted (inserted > 0 means not a
            // duplicate — idempotency guard). Gates: parent precision-feedback
            // flag (already checked above) AND ANTFLEET_PRECISION_AUTORETRACT.
            if (inserted > 0 && isPrecisionAutoRetractEnabled()) {
              try {
                const retracted = await retractFindingByDismiss(
                  dismissCmd.findingId,
                  dismissCmd.reason,
                );
                logInfo("webhook.dismiss_autoretracted", {
                  delivery,
                  findingId: dismissCmd.findingId,
                  retracted,
                });
              } catch (retractErr) {
                logError("webhook.dismiss_autoretract_failed", {
                  delivery,
                  findingId: dismissCmd.findingId,
                  message: messageOf(retractErr),
                });
              }
            }
          } catch (err) {
            logError("webhook.dismiss_command_failed", {
              delivery,
              findingId: dismissCmd.findingId,
              message: messageOf(err),
            });
          }
        }
      });
    }
    return NextResponse.json({ ok: true });
  }

  if (githubEvent !== "pull_request" || action === null || !DISPATCH_ACTIONS.has(action)) {
    return NextResponse.json({ ok: true });
  }

  const pr = asPullRequestPayload(payload);
  if (pr === null) {
    logWarn("webhook.dispatch_skipped", { delivery, reason: "payload shape mismatch" });
    return NextResponse.json({ ok: true });
  }

  // Paywall gate. Looks up the install row + its channel; classifies the
  // webhook as not_installed (no-op), bypass (legacy_partner), insufficient
  // (post invoice, skip enqueue), or debit (atomic CAS before enqueue).
  // The actual debit happens *after* enqueueReview returns so duplicate
  // deliveries (idempotent on the (repo_hash, pr_number, commit_sha)
  // triple) don't double-charge — only the isNew=true delivery pays.
  const gateDecision = await decideGate({
    installationId: pr.installation.id,
    repo: pr.repository.name,
  });
  if (gateDecision.kind === "not_installed") {
    logInfo("webhook.install_not_approved", {
      delivery,
      installationId: pr.installation.id,
      owner: pr.repository.owner.login,
      repo: pr.repository.name,
    });
    return NextResponse.json({ ok: true });
  }

  // Fast path before scheduling background work: prove App auth + insert a
  // stub reviews row so the receipt is durable even if the review itself
  // fails downstream. Failure here returns 5xx so GitHub retries; failure
  // inside after() updates the row with the error.
  let installationToken: string;
  try {
    installationToken = await getInstallationToken(pr.installation.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("webhook.installation_token_failed", {
      delivery,
      installationId: pr.installation.id,
      message,
    });
    return new NextResponse("auth failure", { status: 500 });
  }

  // Mission 5 — public-repo receipt visibility default. Public GitHub repos
  // have no privacy expectation, so their receipts default to public;
  // private repos and any lookup failure default to false. The schema-level
  // default also stays false (see db/schema.ts) so any code path bypassing
  // this site lands on the safe side. isPublicRepo never throws.
  // Mission 6 — benchmark-class detection runs in parallel: a repo with
  // BENCHMARK.md at root opts into /benchmarks regardless of close state.
  const visibilityOctokit = new Octokit({ auth: installationToken });
  const [publicReceiptCandidate, isBenchmark, cyberTier] = await Promise.all([
    isPublicRepo(visibilityOctokit, pr.repository.owner.login, pr.repository.name),
    isBenchmarkRepo(visibilityOctokit, pr.repository.owner.login, pr.repository.name),
    getRepoCyberTier(pr.repository.owner.login, pr.repository.name),
  ]);
  // Cyber tier MUST materialize publicReceipt=false at enqueue time so
  // the persisted row matches reality even if the repo is later
  // downgraded back to default tier or if a future public consumer
  // forgets the side-table cyber filter. (Architect + security audit
  // pass-1, severity medium/high, materialization.)
  const publicReceipt = cyberTier === "cyber" ? false : publicReceiptCandidate;

  // Mission 7 — durable queuing. enqueueReview is idempotent on the
  // (repo_hash, pr_number, commit_sha) triple. A duplicate delivery
  // (GitHub retry, our own retry script pushing an empty commit
  // with the same head sha, etc.) returns isNew=false and we suppress
  // the after() so we don't spawn a second concurrent worker for the
  // same review.
  const repoHash = hashRepo(pr.repository.owner.login, pr.repository.name);
  let enqueued: Awaited<ReturnType<typeof enqueueReview>>;
  try {
    enqueued = await enqueueReview({
      repoHash,
      prNumber: pr.number,
      commitSha: pr.pull_request.head.sha,
      filesReviewed: [],
      promptVersion: "spike-v1",
      providerModelIds: {},
      providerResponses: { status: "pending" },
      agreementDecision: { status: "pending" },
      timingMs: 0,
      costEstimatedUsd: 0,
      schemaVersion: 1,
      installationId: pr.installation.id,
      owner: pr.repository.owner.login,
      repo: pr.repository.name,
      publicReceipt,
      isBenchmark,
    });
  } catch (err) {
    logError("webhook.enqueue_failed", { delivery, message: messageOf(err) });
    return new NextResponse("db failure", { status: 500 });
  }
  const { reviewId, isNew } = enqueued;

  logInfo("webhook.dispatched", {
    delivery,
    action,
    reviewId,
    isNew,
    installationId: pr.installation.id,
    prNumber: pr.number,
    commitSha: pr.pull_request.head.sha,
  });

  // Duplicate delivery: a prior call already enqueued this exact
  // (repo, pr, head_sha). Don't spawn a second worker — the original
  // one (or the retry cron) will settle the row. Critically, also do
  // NOT re-apply the gate / debit: the original delivery already paid
  // for this review (or correctly skipped it).
  if (!isNew) {
    return NextResponse.json({ ok: true, reviewId, duplicate: true });
  }

  // Apply the gate to the freshly-enqueued row. Three terminal outcomes
  // short-circuit the worker spawn:
  //
  //   insufficient  → mark the review failed, post the x402 invoice
  //                   comment on the PR, no after() spawn.
  //   debit-raced   → balance dropped below price between the gate read
  //                   above and the atomic CAS here (concurrent webhook
  //                   for a different PR already drained it). Same as
  //                   insufficient.
  //   bypass        → legacy_partner row, no debit, proceed.
  //   debit-ok     → atomic debit succeeded, record the drawdown
  //                   ledger row linked to reviewId, proceed.
  const gateOutcome = await applyGateToReview({
    decision: gateDecision,
    reviewId,
    octokit: visibilityOctokit,
    prOwner: pr.repository.owner.login,
    prRepo: pr.repository.name,
    prNumber: pr.number,
    delivery,
  });
  if (gateOutcome === "skipped") {
    return NextResponse.json({ ok: true, reviewId, skipped: "insufficient_balance" });
  }

  // Best-effort first attempt. The webhook still kicks off the review
  // immediately inside after() so the happy path stays as fast as the
  // V2/V3 baseline. Failures (rate limits, function timeouts,
  // crashes) leave the row in pending_retry / in_progress; the
  // /api/cron/review-retry tick picks them up and drives them to
  // a terminal state.
  after(async () => {
    try {
      const outcome = await runReviewWorker(reviewId, "webhook");
      logInfo("webhook.worker_outcome", {
        delivery,
        reviewId,
        kind: outcome.kind,
      });
    } catch (err) {
      // runReviewWorker is expected to swallow all known errors and
      // settle the row. A throw here is an unexpected codepath; log
      // loudly so the retry cron is the recovery surface.
      logError("webhook.worker_threw", {
        delivery,
        reviewId,
        message: messageOf(err),
      });
    }
  });

  return NextResponse.json({ ok: true, reviewId });
}

// Applies a precomputed GateDecision to a freshly-enqueued review row.
// Returns "skipped" if the caller should NOT spawn the worker (insufficient
// balance, or racy debit failure); "ok" otherwise (bypass or successful
// debit + drawdown).
async function applyGateToReview(args: {
  decision: Exclude<GateDecision, { kind: "not_installed" }>;
  reviewId: string;
  octokit: Octokit;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  delivery: string | null;
}): Promise<"skipped" | "ok"> {
  const { decision, reviewId, octokit, prOwner, prRepo, prNumber, delivery } = args;

  if (decision.kind === "bypass") {
    logInfo("webhook.gate.bypass", {
      delivery,
      reviewId,
      installationRowId: decision.installationRowId,
    });
    return "ok";
  }

  if (decision.kind === "insufficient") {
    await failInsufficient({
      reviewId,
      decision,
      octokit,
      prOwner,
      prRepo,
      prNumber,
      delivery,
      reason: "insufficient_at_gate",
    });
    return "skipped";
  }

  // decision.kind === "debit" — delegate the quantize → debitChannel →
  // recordDrawdown sequence to the shared helper. Both this surface and
  // the on-demand /api/v1/installations/{id}/review endpoint funnel
  // through debitForReview so the channel state mutation lives in
  // exactly one place. Webhook keeps its own outer wrapper because the
  // "insufficient" branch posts a PR invoice comment; the API endpoint
  // returns 402 JSON instead.
  const debitResult = await debitForReview(db, {
    decision,
    reviewId,
    logContext: { delivery, surface: "webhook" },
  });
  if (!debitResult.ok) {
    await failInsufficient({
      reviewId,
      decision,
      octokit,
      prOwner,
      prRepo,
      prNumber,
      delivery,
      reason: debitResult.reason,
    });
    return "skipped";
  }

  logInfo("webhook.gate.debited", {
    delivery,
    reviewId,
    channelId: decision.channelId,
    priceUsdc: debitResult.debitedUsdc,
    newBalanceUsdc: debitResult.newBalanceUsdc,
  });
  return "ok";
}

type PaywallActiveDecision = {
  kind: "insufficient" | "debit";
  installationRowId: string;
  channelId: string;
  balanceUsdc: string;
  priceUsdc: string;
  walletAddress: string;
};

async function failInsufficient(args: {
  reviewId: string;
  decision: PaywallActiveDecision;
  octokit: Octokit;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  delivery: string | null;
  reason: string;
}): Promise<void> {
  await markReviewTerminallyFailed({
    reviewId: args.reviewId,
    now: new Date(),
    error: args.reason,
  });
  const depositAddress = getDepositAddress();
  if (depositAddress === null) {
    // No deposit address configured — the agent literally cannot top up.
    // Skip the comment so we don't post a misleading invoice with an
    // empty address; the review-failed row is enough audit trail.
    logWarn("webhook.gate.invoice_skipped", {
      delivery: args.delivery,
      reviewId: args.reviewId,
      reason: "deposit_address_unconfigured",
    });
    return;
  }
  const topUp = args.decision.priceUsdc;
  const invoice = buildInvoice({
    topUpUsdc: topUp,
    depositAddress,
    walletAddress: args.decision.walletAddress,
  });
  const body = renderInvoiceComment({
    invoice,
    depositAddress,
    walletAddress: args.decision.walletAddress,
    topUpUsdc: topUp,
    currentBalanceUsdc: args.decision.balanceUsdc,
    priceUsdc: args.decision.priceUsdc,
  });
  try {
    await args.octokit.rest.issues.createComment({
      owner: args.prOwner,
      repo: args.prRepo,
      issue_number: args.prNumber,
      body,
    });
    logInfo("webhook.gate.invoice_posted", {
      delivery: args.delivery,
      reviewId: args.reviewId,
      reason: args.reason,
    });
  } catch (err) {
    logError("webhook.gate.invoice_post_failed", {
      delivery: args.delivery,
      reviewId: args.reviewId,
      message: messageOf(err),
    });
  }
}
