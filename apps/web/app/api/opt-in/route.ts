import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { logInfo, logWarn } from "@/lib/log";
import { tokenLogId, verifyTokenDetailed, type OptInPayload } from "@/lib/optin-token";
import {
  flipPublicReceiptForRepo,
  hashRepo,
  recordOnboardingEvent,
} from "@/db/queries";

// node:crypto + DB driver are Node-only — lock this route off the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OptInAction = "enable" | "disable";

export type OptInDeps = {
  flipReceipt: typeof flipPublicReceiptForRepo;
  recordEvent: typeof recordOnboardingEvent;
};

const DEFAULT_DEPS: OptInDeps = {
  flipReceipt: flipPublicReceiptForRepo,
  recordEvent: recordOnboardingEvent,
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handleOptIn(req, DEFAULT_DEPS);
}

export async function handleOptIn(
  req: NextRequest,
  deps: OptInDeps,
): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  const actionParam = url.searchParams.get("action");
  const action: OptInAction = actionParam === "disable" ? "disable" : "enable";

  if (token === null || token.length === 0) {
    logWarn("optin.missing_token", { action });
    return htmlResponse(400, errorPage("Missing token", "This opt-in link is missing its token. Re-open the link from the original GitHub comment."));
  }

  const verified = verifyTokenDetailed(token);
  const logId = tokenLogId(token);

  if (verified.kind === "expired") {
    logInfo("optin.token_expired", { logId, action });
    return htmlResponse(410, errorPage(
      "Link expired",
      "This opt-in link is more than 30 days old. Reply on the original GitHub comment and we'll resend a fresh link.",
    ));
  }
  if (verified.kind === "invalid") {
    logWarn("optin.token_invalid", { logId, action });
    return htmlResponse(400, errorPage(
      "Invalid link",
      "This opt-in link is malformed or has been tampered with. If you copied it from the GitHub comment, please try again.",
    ));
  }

  const target = action === "enable";
  const payload = verified.payload;
  const result = await deps.flipReceipt({
    installationId: payload.installationId,
    owner: payload.owner,
    repo: payload.repo,
    target,
  });

  if (result.totalMatching === 0) {
    logInfo("optin.no_reviews", { logId, action, ...debugForPayload(payload) });
    return htmlResponse(200, infoPage(
      "No reviews here yet",
      `We don't have any reviews on file for ${payload.owner}/${payload.repo} yet. Once your first PR is reviewed, the opt-in link in the summary comment will work.`,
      payload,
      action,
    ));
  }

  if (result.flipped === 0) {
    logInfo("optin.noop", { logId, action, alreadyMatching: result.alreadyMatching, ...debugForPayload(payload) });
    return htmlResponse(200, successPage(
      target ? "Already enabled" : "Already disabled",
      target
        ? `Public receipts were already enabled for ${payload.owner}/${payload.repo}. Closed findings show up on /receipts.`
        : `Public receipts were already disabled for ${payload.owner}/${payload.repo}. Nothing on /receipts.`,
      payload,
      action,
    ));
  }

  try {
    await deps.recordEvent({
      eventType: target ? "public_receipts_enabled" : "public_receipts_disabled",
      installationId: payload.installationId,
      owner: payload.owner,
      repo: payload.repo,
      repoHash: hashRepo(payload.owner, payload.repo),
      modelId: null,
      prompt: null,
      toolOutput: {
        summary: target
          ? "Self-serve opt-in via signed link"
          : "Self-serve opt-out via signed link",
        flipped_review_count: result.flipped,
        already_matching: result.alreadyMatching,
        total_matching: result.totalMatching,
      },
      commentId: null,
      commentUrl: null,
      public: target,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Flip already succeeded; surface success to the user but log the
    // audit-row miss so it can be backfilled.
    logWarn("optin.event_persist_failed", {
      logId,
      action,
      message,
      ...debugForPayload(payload),
    });
  }

  logInfo("optin.flipped", {
    logId,
    action,
    flipped: result.flipped,
    totalMatching: result.totalMatching,
    ...debugForPayload(payload),
  });

  return htmlResponse(200, successPage(
    target ? "Public receipts enabled" : "Public receipts disabled",
    target
      ? `Closed findings for ${payload.owner}/${payload.repo} will now appear on /receipts. ${result.flipped} existing review(s) backfilled.`
      : `${payload.owner}/${payload.repo} is back to private. ${result.flipped} review(s) hidden from /receipts.`,
    payload,
    action,
  ));
}

function debugForPayload(p: OptInPayload): {
  installationId: number;
  owner: string;
  repo: string;
} {
  return { installationId: p.installationId, owner: p.owner, repo: p.repo };
}

function htmlResponse(status: number, body: string): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function pageShell(args: { title: string; body: string }): string {
  // Inline minimal styling — keeps the route framework-free and avoids
  // pulling the Next layout tree into a one-off opt-in confirmation.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AntFleet · ${escapeHtml(args.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<style>
:root {
  color-scheme: light dark;
  --ink: #0a0a0a;
  --ink-muted: #4a4a4a;
  --ink-subtle: #888;
  --line: #e5e5e5;
  --bg: #fafafa;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #f5f5f5; --ink-muted: #b5b5b5; --ink-subtle: #888; --line: #2a2a2a; --bg: #0a0a0a; }
}
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 32rem; margin: 6rem auto; padding: 0 1.5rem; }
.label { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.14em; color: var(--ink-subtle); margin-bottom: 1rem; }
h1 { font-size: 1.4rem; font-weight: 600; line-height: 1.3; margin: 0 0 1rem; letter-spacing: -0.01em; }
p { font-size: 0.95rem; line-height: 1.55; color: var(--ink-muted); margin: 0 0 0.9rem; }
a { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
a:hover { opacity: 0.7; }
.divider { border-top: 1px solid var(--line); margin: 2rem 0 1.25rem; }
.footer { font-size: 0.78rem; color: var(--ink-subtle); }
.footer code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.72rem; }
</style>
</head>
<body>
<main>
<div class="label">AntFleet · Onboarder</div>
${args.body}
</main>
</body>
</html>`;
}

function successPage(
  title: string,
  message: string,
  payload: OptInPayload,
  action: OptInAction,
): string {
  const reverseAction: OptInAction = action === "enable" ? "disable" : "enable";
  const reverseLabel = reverseAction === "disable" ? "disable public receipts" : "re-enable public receipts";
  return pageShell({
    title,
    body: `
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>View the public log at <a href="/receipts">/receipts</a> or read the <a href="/policy">data policy</a>.</p>
<div class="divider"></div>
<p class="footer">Need to ${escapeHtml(reverseLabel)}? Reply on the GitHub comment that linked you here — the same comment carries the reversal link. The full opt-in path lives in <code>/policy</code>.</p>
`,
  });
}

function infoPage(
  title: string,
  message: string,
  _payload: OptInPayload,
  _action: OptInAction,
): string {
  return pageShell({
    title,
    body: `
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>Once a PR lands, the Onboarder will post a fresh opt-in link in the summary comment. <a href="/">Back to AntFleet</a>.</p>
`,
  });
}

function errorPage(title: string, message: string): string {
  return pageShell({
    title,
    body: `
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>If you need a hand, email <a href="mailto:agent@antfleet.dev">agent@antfleet.dev</a> and we'll flip the flag manually.</p>
`,
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
