import type { NextRequest } from "next/server";
import { NextResponse, after } from "next/server";
import { verifyGitHubSignature } from "@/lib/github-signature";
import { getInstallationToken } from "@/lib/github-app";
import { getChangedFiles } from "@/lib/github-files";
import { reviewPR } from "@/lib/review-pipeline";
import { logError, logInfo, logWarn } from "@/lib/log";
import { hashRepo, recordReview, updateReview } from "@/db/queries";

// node:crypto is Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";

// Hobby plan max; Pro can go up to 300. The review pipeline takes 60–90s in
// V2/V3 data; this matches the upper bound we observed.
export const maxDuration = 60;

const DISPATCH_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

type PullRequestPayload = {
  action: string;
  number: number;
  installation: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: { head: { sha: string } };
};

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
        },
        timingMs: bundle.totalMs,
        costEstimatedUsd: bundle.estimatedCostUsd,
      });
      logInfo("review.completed", {
        reviewId,
        delivery,
        agreedCount: bundle.agreed.length,
        totalMs: bundle.totalMs,
        estimatedCostUsd: bundle.estimatedCostUsd,
        providerStatuses: bundle.perProvider.map((p) => ({
          name: p.name,
          ok: p.output !== null,
          ms: p.ms,
        })),
      });
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
