import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyGitHubSignature } from "@/lib/github-signature";
import { getInstallationToken } from "@/lib/github-app";
import { logError, logInfo, logWarn } from "@/lib/log";
import { hashRepo, recordReview } from "@/db/queries";

// node:crypto is Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";

const DISPATCH_ACTIONS = new Set(["opened", "reopened", "synchronize"]);

// Minimal subset of the pull_request webhook payload we touch. The DB row's
// provider_responses JSONB captures the rest verbatim in slice 4+; for slice 3
// we just need enough to identify the PR.
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

  if (githubEvent === "pull_request" && action !== null && DISPATCH_ACTIONS.has(action)) {
    const pr = asPullRequestPayload(payload);
    if (pr === null) {
      logWarn("webhook.dispatch_skipped", { delivery, reason: "payload shape mismatch" });
      return NextResponse.json({ ok: true });
    }
    try {
      // Prove App auth works end-to-end. The token isn't used in slice 3 — slice
      // 4 will fetch changed files with it — but failing fast here surfaces a
      // misconfigured PEM or App ID at the first PR instead of two slices later.
      await getInstallationToken(pr.installation.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("webhook.installation_token_failed", { delivery, installationId: pr.installation.id, message });
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
        promptVersion: "stub-1",
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
  }

  return NextResponse.json({ ok: true });
}
