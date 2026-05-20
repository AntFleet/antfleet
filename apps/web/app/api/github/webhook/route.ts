import type { NextRequest } from "next/server";
import { NextResponse, after } from "next/server";
import { Octokit } from "@octokit/rest";
import { verifyGitHubSignature } from "@/lib/github-signature";
import { getInstallationToken } from "@/lib/github-app";
import { isPublicRepo } from "@/lib/repo-visibility";
import { isBenchmarkRepo } from "@/lib/repo-benchmark";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { isWelcomeIssue, recordPartnerReply, runWelcomeOnInstall } from "@/lib/onboarder";
import { runReviewWorker } from "@/lib/review-worker";
import { enqueueReview, hashRepo, isInstallApproved, upsertInstallEntry } from "@/db/queries";

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
  return {
    installationId,
    owner: owner["login"],
    repo: repository["name"],
    issueNumber: issue["number"],
    commentId: comment["id"],
    commentUrl: comment["html_url"],
    body: comment["body"],
    sender: { login: sender["login"], type: sender["type"] },
  };
}

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
  if (githubEvent === "issue_comment" && action === "created") {
    const ic = asIssueCommentPayload(payload);
    if (ic !== null && ic.sender.login !== "antfleet[bot]") {
      after(async () => {
        try {
          const isWelcome = await isWelcomeIssue(
            ic.installationId,
            ic.owner,
            ic.repo,
            ic.issueNumber,
          );
          if (!isWelcome) return;
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
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError("webhook.partner_reply_dispatch_failed", { delivery, message });
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

  const approved = await isInstallApproved(pr.installation.id, pr.repository.name);
  if (!approved) {
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
  const [publicReceipt, isBenchmark] = await Promise.all([
    isPublicRepo(visibilityOctokit, pr.repository.owner.login, pr.repository.name),
    isBenchmarkRepo(visibilityOctokit, pr.repository.owner.login, pr.repository.name),
  ]);

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
  // one (or the retry cron) will settle the row.
  if (!isNew) {
    return NextResponse.json({ ok: true, reviewId, duplicate: true });
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
