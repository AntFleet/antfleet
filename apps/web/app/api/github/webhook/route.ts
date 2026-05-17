import type { NextRequest } from "next/server";
import { NextResponse, after } from "next/server";
import { verifyGitHubSignature } from "@/lib/github-signature";
import { getInstallationToken } from "@/lib/github-app";
import { getChangedFiles } from "@/lib/github-files";
import { reviewPR } from "@/lib/review-pipeline";
import { formatPRComment, postPRComment } from "@/lib/pr-comment";
import { logError, logInfo, logWarn } from "@/lib/log";
import {
  runFirstReviewSummary,
  runWelcomeOnInstall,
} from "@/lib/onboarder";
import {
  hashRepo,
  recordFindingStatuses,
  recordReview,
  setReviewComment,
  updateReview,
} from "@/db/queries";

// node:crypto is Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";

// Pro plan ceiling — 300s. The 60s self-imposed limit from earlier matched
// the V2/V3 observed upper bound for tight single-file reviews, but the
// first production smoke test (Augustas11/antfleet PR #1, 5 files) blew
// past it and got killed mid-review. Bumped to the plan max so multi-file
// PRs reliably complete; revisit if we move off Pro or restructure the
// review into a separately-dispatched worker (e.g. QStash / Inngest).
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
          await runWelcomeOnInstall(w);
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
          await runWelcomeOnInstall(w);
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

  // Fast path before scheduling background work: prove App auth + insert a
  // stub reviews row so the receipt is durable even if the review itself
  // fails downstream. Failure here returns 5xx so GitHub retries; failure
  // inside after() updates the row with the error.
  try {
    await getInstallationToken(pr.installation.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("webhook.installation_token_failed", {
      delivery,
      installationId: pr.installation.id,
      message,
    });
    return new NextResponse("auth failure", { status: 500 });
  }

  const repoHash = hashRepo(pr.repository.owner.login, pr.repository.name);
  let reviewId: string;
  try {
    reviewId = await recordReview({
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
      // Mission 3 slice 3-5 — sweep needs these to re-auth + call GitHub.
      // Persisted at stub-row time so failure mid-review still leaves a
      // sweepable row.
      installationId: pr.installation.id,
      owner: pr.repository.owner.login,
      repo: pr.repository.name,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("webhook.recordReview_failed", { delivery, message });
    return new NextResponse("db failure", { status: 500 });
  }

  logInfo("webhook.dispatched", {
    delivery,
    action,
    reviewId,
    installationId: pr.installation.id,
    prNumber: pr.number,
    commitSha: pr.pull_request.head.sha,
  });

  // Heavy lifting runs after the 200 — GitHub stops retrying immediately
  // while the actual review keeps going. Errors are caught and persisted
  // to the row's providerResponses field rather than thrown.
  after(async () => {
    try {
      const files = await getChangedFiles({
        installationId: pr.installation.id,
        owner: pr.repository.owner.login,
        repo: pr.repository.name,
        prNumber: pr.number,
        headSha: pr.pull_request.head.sha,
      });
      logInfo("review.files_fetched", {
        reviewId,
        delivery,
        fileCount: files.length,
        filenames: files.map((f) => f.filename),
      });
      if (files.length === 0) {
        await updateReview(reviewId, {
          filesReviewed: [],
          providerResponses: { status: "skipped", reason: "no reviewable files" },
          agreementDecision: { status: "skipped" },
        });
        logInfo("review.skipped", { reviewId, delivery, reason: "no reviewable files" });
        return;
      }
      const bundle = await reviewPR({
        files,
        owner: pr.repository.owner.login,
        repo: pr.repository.name,
        prNumber: pr.number,
      });
      await updateReview(reviewId, {
        filesReviewed: files.map((f) => f.filename),
        providerModelIds: bundle.modelIds,
        providerResponses: { perProvider: bundle.perProvider },
        agreementDecision: {
          mode: bundle.agreementMode,
          agreed: bundle.agreed,
          disagreements: bundle.disagreements,
          degraded: bundle.degraded,
          degradedReason: bundle.degradedReason,
        },
        timingMs: bundle.totalMs,
        costEstimatedUsd: bundle.estimatedCostUsd,
      });
      logInfo("review.completed", {
        reviewId,
        delivery,
        agreedCount: bundle.agreed.length,
        degraded: bundle.degraded,
        degradedReason: bundle.degradedReason,
        totalMs: bundle.totalMs,
        estimatedCostUsd: bundle.estimatedCostUsd,
        providerStatuses: bundle.perProvider.map((p) => ({
          name: p.name,
          ok: p.output !== null,
          ms: p.ms,
        })),
      });

      // Onboarder first-review summary fires AFTER the review work
      // is captured, regardless of agreed/degraded state. It self-
      // gates on (a) ONBOARDER_ENABLED and (b) being the install's
      // first review — see runFirstReviewSummary for the math. Logs
      // failures but never bubbles; the review itself is independent.
      try {
        const perProviderFindingCounts: Record<string, number> = {};
        for (const p of bundle.perProvider) {
          perProviderFindingCounts[p.name] = p.output?.findings.length ?? 0;
        }
        await runFirstReviewSummary({
          installationId: pr.installation.id,
          owner: pr.repository.owner.login,
          repo: pr.repository.name,
          prNumber: pr.number,
          perProviderFindingCounts,
          agreedCount: bundle.agreed.length,
          disagreementCount: bundle.disagreements.length,
          modelIds: bundle.modelIds,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError("onboarder.first_review_summary_dispatch_failed", {
          reviewId,
          delivery,
          message,
        });
      }

      // Honest-report gate: post only when two voters actually agreed.
      // Degraded runs and 0-finding agreement sets are silent — the audit
      // trail still captures everything (DB row + log lines), but the
      // public artifact only appears when there is something to receipt.
      if (!bundle.degraded && bundle.agreed.length > 0) {
        const commentBody = formatPRComment(bundle.agreed, {
          reviewId,
          totalMs: bundle.totalMs,
          estimatedCostUsd: bundle.estimatedCostUsd,
          modelIds: bundle.modelIds,
        });
        try {
          const posted = await postPRComment({
            installationId: pr.installation.id,
            owner: pr.repository.owner.login,
            repo: pr.repository.name,
            prNumber: pr.number,
            body: commentBody,
          });
          logInfo("comment.posted", {
            reviewId,
            delivery,
            commentId: posted.id,
            commentUrl: posted.htmlUrl,
            findingCount: bundle.agreed.length,
          });
          // Mission 3 lifecycle: persist the comment id + a row per agreed
          // finding so Sweeper can reconcile later. Best-effort — DB write
          // failure here doesn't undo the posted comment, but is loud in
          // logs so Sweeper missing rows is easy to spot.
          try {
            await setReviewComment({
              reviewId,
              commentId: posted.id,
              commentUrl: posted.htmlUrl,
            });
            const findingIds = await recordFindingStatuses(
              reviewId,
              bundle.agreed.map((f) => ({
                title: f.title,
                severity: f.severity,
                category: f.category,
              })),
            );
            logInfo("lifecycle.recorded", {
              reviewId,
              delivery,
              findingIds,
              commentId: posted.id,
            });
          } catch (lifecycleErr) {
            const message =
              lifecycleErr instanceof Error ? lifecycleErr.message : String(lifecycleErr);
            logError("lifecycle.persist_failed", { reviewId, delivery, message });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Comment failure does NOT fail the review. The DB row is still
          // the source of truth; we just lost the visible artifact for
          // this delivery.
          logError("comment.post_failed", { reviewId, delivery, message });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("review.failed", { reviewId, delivery, message });
      try {
        await updateReview(reviewId, {
          providerResponses: { status: "error", message },
          agreementDecision: { status: "error" },
        });
      } catch (updateErr) {
        const updateMessage = updateErr instanceof Error ? updateErr.message : String(updateErr);
        logError("review.failure_persist_failed", { reviewId, delivery, message: updateMessage });
      }
    }
  });

  return NextResponse.json({ ok: true, reviewId });
}
