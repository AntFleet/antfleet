import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";
import { getInstallationToken } from "./github-app";
import { logError, logInfo, logWarn } from "./log";
import { buildOptInUrl } from "./optin-token";
import {
  countReviewsForInstall,
  getOnboardingEventForInstall,
  hashRepo,
  hasOnboardingEventForInstall,
  isWelcomeIssue,
  loadCheckInCandidates,
  recordOnboardingEvent,
  snapshotInstallActivity,
} from "@/db/queries";
import type { OnboarderEventType } from "@/db/queries";

// Onboarder — the third AntFleet agent. Owns the partner-facing
// lifecycle: install welcome, first-review summary, public-receipts
// intake, 7-day check-in. Audit trail mirrors the Reviewer pipeline:
// every action persists a row in onboarding_events with model id +
// prompt + structured tool output.
//
// Gated behind ONBOARDER_ENABLED env var. Default disabled in every
// environment until explicitly flipped — keeps the agent silent during
// Phase 2 cutover so partner conversations control the rollout rather
// than the next webhook event doing it for us.

const ONBOARDER_MODEL = "claude-opus-4-7";
const ONBOARDER_MAX_TOKENS = 1024;
const ANTHROPIC_CLIENT_OPTS = { timeout: 60_000, maxRetries: 3 } as const;

export function isOnboarderEnabled(): boolean {
  return process.env["ONBOARDER_ENABLED"] === "true";
}

// ─── tool schemas ───────────────────────────────────────────────────────────

const WELCOME_SCHEMA = {
  type: "object",
  properties: {
    issue_title: {
      type: "string",
      description: "GitHub issue title. Short, no emoji, technical voice.",
    },
    issue_body: {
      type: "string",
      description:
        "GitHub issue body in markdown. 150-300 words. Acknowledge the install, explain what Reviewer does on the next PR, mention the two-model unanimous gate, link to https://www.antfleet.dev/architecture, invite the maintainer to close the issue when ready.",
    },
  },
  required: ["issue_title", "issue_body"],
  additionalProperties: false,
} as const;

const FIRST_REVIEW_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    comment_body: {
      type: "string",
      description:
        "GitHub comment body in markdown. 100-200 words. Acknowledge this is the install's first review, explain what the unanimous gate did on this specific PR (how many findings each model produced, how many crossed the gate, what was dropped), invite reaction signal (👎 on noise). Sign off as Onboarder.",
    },
  },
  required: ["comment_body"],
  additionalProperties: false,
} as const;

const CHECK_IN_SCHEMA = {
  type: "object",
  properties: {
    comment_body: {
      type: "string",
      description:
        "GitHub comment body in markdown. 100-150 words. Summarize the install's first 7 days of activity (reviews run, findings agreed, findings closed, reactions observed). Highlight anything notable. Ask whether anything seems off. Sign off as Onboarder.",
    },
  },
  required: ["comment_body"],
  additionalProperties: false,
} as const;

// ─── Anthropic call wrapper ─────────────────────────────────────────────────

type OnboarderCallResult<T> = { output: T; promptUsed: string; modelId: string };

async function callOnboarderTool<T>(args: {
  prompt: string;
  toolName: string;
  toolDescription: string;
  schema: object;
}): Promise<OnboarderCallResult<T>> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("ONBOARDER_MISCONFIGURED: ANTHROPIC_API_KEY missing");
  }
  const client = new Anthropic({ apiKey, ...ANTHROPIC_CLIENT_OPTS });
  const response = await client.messages.create({
    model: ONBOARDER_MODEL,
    max_tokens: ONBOARDER_MAX_TOKENS,
    tools: [
      {
        name: args.toolName,
        description: args.toolDescription,
        input_schema: args.schema as Anthropic.Messages.Tool["input_schema"],
      },
    ],
    tool_choice: { type: "tool", name: args.toolName },
    messages: [{ role: "user", content: args.prompt }],
  });
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === args.toolName) {
      return {
        output: block.input as T,
        promptUsed: args.prompt,
        modelId: ONBOARDER_MODEL,
      };
    }
  }
  throw new Error(`ONBOARDER_BAD_RESPONSE: missing tool_use(${args.toolName})`);
}

// ─── repo metadata fetch (best-effort) ──────────────────────────────────────

type RepoMeta = {
  description: string | null;
  language: string | null;
  topics: readonly string[];
};

async function fetchRepoMeta(
  installationId: number,
  owner: string,
  repo: string,
): Promise<RepoMeta> {
  try {
    const token = await getInstallationToken(installationId);
    const octokit = new Octokit({ auth: token });
    const resp = await octokit.rest.repos.get({ owner, repo });
    return {
      description: resp.data.description ?? null,
      language: resp.data.language ?? null,
      topics: resp.data.topics ?? [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logWarn("onboarder.repo_meta_failed", { owner, repo, message });
    return { description: null, language: null, topics: [] };
  }
}

// ─── base URL for self-serve links ─────────────────────────────────────────

function onboarderBaseUrl(): string {
  // Prefer an explicit canonical override (set in prod), fall back to the
  // Vercel-injected production URL, then to localhost for dev. The opt-in
  // link lives in a public GitHub comment so it must always be absolute.
  const override = process.env["ANTFLEET_PUBLIC_BASE_URL"];
  if (override !== undefined && override.length > 0) return override;
  const vercel = process.env["VERCEL_PROJECT_PRODUCTION_URL"];
  if (vercel !== undefined && vercel.length > 0) return `https://${vercel}`;
  return "http://localhost:3000";
}

// ─── prompts ────────────────────────────────────────────────────────────────

export function welcomePrompt(args: { owner: string; repo: string; meta: RepoMeta }): string {
  const metaLines = [
    args.meta.description !== null ? `Description: ${args.meta.description}` : null,
    args.meta.language !== null ? `Primary language: ${args.meta.language}` : null,
    args.meta.topics.length > 0 ? `Topics: ${args.meta.topics.join(", ")}` : null,
  ].filter((line): line is string => line !== null);
  const metaBlock = metaLines.length > 0 ? metaLines.join("\n") : "(no public metadata available)";
  return `You are the AntFleet Onboarder, the agent that greets new installations.

The AntFleet GitHub App was just installed on:

  Repository: ${args.owner}/${args.repo}

Repository metadata:
${metaBlock}

Compose a welcome GitHub issue to open in this repo. Voice: direct, technical, no marketing fluff (the AntFleet brand is Stripe + Linear, not SaaS-cheerful). The issue should:

- Acknowledge the install in one sentence
- Tell the maintainer what happens next: on the next PR opened, two independent frontier models (Claude Opus 4.7 and GPT-5) will review changed files in parallel; only findings both models flag get posted as a comment; typical latency is 30-90s for small PRs
- For AI agents specifically: point them at the agent signup loop at https://www.antfleet.dev/llms.txt and the machine-readable manifest at https://www.antfleet.dev/.well-known/antfleet.json. If the installer is a human partner, this paragraph can be one line; if it's an agent, surface those two URLs prominently.
- Link to https://www.antfleet.dev/architecture for the full agent diagram
- Mention that public receipts are off by default; the summary comment on the first PR review will include a one-click opt-in link, no email needed
- Close with a short "feel free to close this issue when you're set up" line
- 150-300 words total
- No emoji
- Use markdown headings sparingly (one or two at most)

Return a structured tool call with the issue title and body. The title should be plain and recognizable — something like "AntFleet · welcome" — not clever.`;
}

export function firstReviewSummaryPrompt(args: {
  owner: string;
  repo: string;
  prNumber: number;
  perProviderFindingCounts: Record<string, number>;
  agreedCount: number;
  disagreementCount: number;
  modelIds: Record<string, string>;
  optInUrl: string;
}): string {
  const counts = Object.entries(args.perProviderFindingCounts)
    .map(([name, count]) => `  ${name} (${args.modelIds[name] ?? "?"}): ${count} findings`)
    .join("\n");
  return `You are the AntFleet Onboarder. The Reviewer fleet just completed its first review on a partner repo.

  Repository: ${args.owner}/${args.repo}
  PR: #${args.prNumber}
  Per-provider findings:
${counts}
  After unanimous-gate: ${args.agreedCount} agreed (posted) / ${args.disagreementCount} disagreements (dropped)
  Public-receipts opt-in URL (use VERBATIM, do not edit or shorten):
  ${args.optInUrl}

Compose a follow-up comment on the same PR that frames what happened. This is the partner's FIRST review, so the comment should explain the unanimous gate in concrete terms specific to this PR. Voice: direct, technical, no marketing fluff. The comment should:

- Open with "AntFleet · Onboarder · first-review framing" as the heading
- Summarize the math: model A flagged N, model B flagged M, K both agreed, the rest were dropped
- Note that the silent drops aren't lost — they're persisted in the audit trail (provider_responses) for later analysis
- If agreedCount is 0, frame the silence as expected for the majority of PRs and not as failure
- If agreedCount > 0, point the maintainer at the Reviewer comment for the findings themselves
- Invite reaction feedback: 👎 on any agreed finding that's noise; the eyes reaction also helps
- Include a dedicated line "**Public receipts opt-in:** <the URL>" that contains the opt-in URL above EXACTLY as given (no quoting, no edits, no truncation). One click flips this repo's closed findings onto /receipts; link is good for 30 days. Frame it as opt-in, off by default.
- Mention this Onboarder comment is one-time per install — subsequent PRs are Reviewer-only output
- Sign off with a sub line "— Onboarder · agent@antfleet.dev"
- 100-200 words total
- No emoji except the reactions named above

Return a tool call with the comment body.`;
}

function checkInPrompt(args: {
  owner: string;
  repo: string;
  daysElapsed: number;
  reviewCount: number;
  findingsAgreed: number;
  findingsClosed: number;
  reactionsObserved: number;
}): string {
  return `You are the AntFleet Onboarder. A partner install is ${args.daysElapsed} days old; time for the scheduled check-in.

  Repository: ${args.owner}/${args.repo}
  Reviews run: ${args.reviewCount}
  Findings agreed (posted): ${args.findingsAgreed}
  Findings closed (closure receipts posted): ${args.findingsClosed}
  Maintainer reactions observed: ${args.reactionsObserved}

Compose a check-in comment to post on the original welcome issue. Voice: direct, technical, no marketing fluff. The comment should:

- Open with "AntFleet · Onboarder · ${args.daysElapsed}-day check-in" as the heading
- Summarize the activity numbers in a short bullet list
- If reviewCount is 0, gently flag that no PRs have been reviewed yet and ask if anything is blocking
- If findingsAgreed is high but findingsClosed is 0, note that closure receipts will come once the relevant PRs merge
- If reactionsObserved is non-zero, mention we're treating those as ground-truth signal
- Ask one open question: whether anything has felt off in the first ${args.daysElapsed} days
- Sign off "— Onboarder · agent@antfleet.dev"
- 100-150 words total
- No emoji

Return a tool call with the comment body.`;
}

// ─── top-level orchestrators ────────────────────────────────────────────────

export async function runWelcomeOnInstall(args: {
  installationId: number;
  owner: string;
  repo: string;
}): Promise<void> {
  if (!isOnboarderEnabled()) {
    logInfo("onboarder.welcome_skipped", {
      reason: "ONBOARDER_ENABLED not true",
      owner: args.owner,
      repo: args.repo,
    });
    return;
  }

  // Idempotency: a repo can be added to an install multiple times via
  // installation_repositories.added; we only welcome once per (install, repo).
  const already = await hasOnboardingEventForInstall(
    args.installationId,
    args.owner,
    args.repo,
    "install_welcome",
  );
  if (already) {
    logInfo("onboarder.welcome_already_posted", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
    });
    return;
  }

  const meta = await fetchRepoMeta(args.installationId, args.owner, args.repo);
  let agentOutput: { issue_title: string; issue_body: string };
  let promptUsed: string;
  let modelId: string;
  try {
    const prompt = welcomePrompt({ owner: args.owner, repo: args.repo, meta });
    const result = await callOnboarderTool<{ issue_title: string; issue_body: string }>({
      prompt,
      toolName: "submit_welcome",
      toolDescription: "Submit the welcome issue to open on the freshly-installed repo.",
      schema: WELCOME_SCHEMA,
    });
    agentOutput = result.output;
    promptUsed = result.promptUsed;
    modelId = result.modelId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.welcome_agent_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      message,
    });
    return;
  }

  let issueNumber: number | null = null;
  let issueUrl: string | null = null;
  try {
    const token = await getInstallationToken(args.installationId);
    const octokit = new Octokit({ auth: token });
    const resp = await octokit.rest.issues.create({
      owner: args.owner,
      repo: args.repo,
      title: agentOutput.issue_title,
      body: agentOutput.issue_body,
    });
    issueNumber = resp.data.number;
    issueUrl = resp.data.html_url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.welcome_post_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      message,
    });
    // Still persist the event so we can see what the agent intended,
    // even when GitHub posting failed. The next slice will catch the
    // missing issue_url via a retry.
  }

  try {
    await recordOnboardingEvent({
      eventType: "install_welcome",
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      repoHash: hashRepo(args.owner, args.repo),
      modelId,
      prompt: promptUsed,
      toolOutput: { ...agentOutput, issue_number: issueNumber },
      commentId: issueNumber,
      commentUrl: issueUrl,
      public: false,
    });
    logInfo("onboarder.welcome_posted", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      issueNumber,
      issueUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.welcome_persist_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      message,
    });
  }
}

export async function runFirstReviewSummary(args: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  perProviderFindingCounts: Record<string, number>;
  agreedCount: number;
  disagreementCount: number;
  modelIds: Record<string, string>;
}): Promise<void> {
  if (!isOnboarderEnabled()) return;

  // Only fire for the install's first review. Reviewer has already
  // recorded its row by the time this runs, so count == 1 means this
  // review is the first.
  const reviewCount = await countReviewsForInstall(args.installationId);
  if (reviewCount !== 1) return;

  const already = await hasOnboardingEventForInstall(
    args.installationId,
    args.owner,
    args.repo,
    "first_review_summary",
  );
  if (already) return;

  let agentOutput: { comment_body: string };
  let promptUsed: string;
  let modelId: string;
  let optInUrl: string;
  try {
    optInUrl = buildOptInUrl({
      baseUrl: onboarderBaseUrl(),
      payload: {
        installationId: args.installationId,
        owner: args.owner,
        repo: args.repo,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.optin_url_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      message,
    });
    return;
  }
  try {
    const prompt = firstReviewSummaryPrompt({ ...args, optInUrl });
    const result = await callOnboarderTool<{ comment_body: string }>({
      prompt,
      toolName: "submit_first_review_summary",
      toolDescription: "Submit the first-review framing comment for the partner's first PR.",
      schema: FIRST_REVIEW_SUMMARY_SCHEMA,
    });
    agentOutput = result.output;
    promptUsed = result.promptUsed;
    modelId = result.modelId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.first_review_summary_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      message,
    });
    return;
  }

  let commentId: number | null = null;
  let commentUrl: string | null = null;
  try {
    const token = await getInstallationToken(args.installationId);
    const octokit = new Octokit({ auth: token });
    const resp = await octokit.rest.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.prNumber,
      body: agentOutput.comment_body,
    });
    commentId = resp.data.id;
    commentUrl = resp.data.html_url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.first_review_summary_post_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      message,
    });
  }

  try {
    await recordOnboardingEvent({
      eventType: "first_review_summary",
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      repoHash: hashRepo(args.owner, args.repo),
      modelId,
      prompt: promptUsed,
      toolOutput: { ...agentOutput, pr_number: args.prNumber },
      commentId,
      commentUrl,
      public: false,
    });
    logInfo("onboarder.first_review_summary_posted", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      commentId,
      commentUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.first_review_summary_persist_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      message,
    });
  }
}

export async function runCheckIn(args: {
  installationId: number;
  owner: string;
  repo: string;
  daysElapsed: number;
  reviewCount: number;
  findingsAgreed: number;
  findingsClosed: number;
  reactionsObserved: number;
}): Promise<void> {
  if (!isOnboarderEnabled()) return;

  // Idempotency at the (install, repo, event_type) granularity. A second
  // check-in on the same install would be a 14-day check-in and gets its
  // own event_type when we add it.
  const already = await hasOnboardingEventForInstall(
    args.installationId,
    args.owner,
    args.repo,
    "check_in_7d",
  );
  if (already) return;

  // Need the welcome issue number so we know where to post the check-in.
  const welcome = await getOnboardingEventForInstall(
    args.installationId,
    args.owner,
    args.repo,
    "install_welcome",
  );
  if (welcome === null || welcome.commentId === null) {
    logWarn("onboarder.checkin_no_welcome_issue", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
    });
    return;
  }
  const issueNumber = welcome.commentId;

  let agentOutput: { comment_body: string };
  let promptUsed: string;
  let modelId: string;
  try {
    const prompt = checkInPrompt(args);
    const result = await callOnboarderTool<{ comment_body: string }>({
      prompt,
      toolName: "submit_check_in",
      toolDescription: "Submit the 7-day check-in comment on the partner's welcome issue.",
      schema: CHECK_IN_SCHEMA,
    });
    agentOutput = result.output;
    promptUsed = result.promptUsed;
    modelId = result.modelId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.checkin_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      message,
    });
    return;
  }

  let commentId: number | null = null;
  let commentUrl: string | null = null;
  try {
    const token = await getInstallationToken(args.installationId);
    const octokit = new Octokit({ auth: token });
    const resp = await octokit.rest.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: issueNumber,
      body: agentOutput.comment_body,
    });
    commentId = resp.data.id;
    commentUrl = resp.data.html_url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.checkin_post_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      message,
    });
  }

  try {
    await recordOnboardingEvent({
      eventType: "check_in_7d",
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      repoHash: hashRepo(args.owner, args.repo),
      modelId,
      prompt: promptUsed,
      toolOutput: { ...agentOutput, welcome_issue: issueNumber },
      commentId,
      commentUrl,
      public: false,
    });
    logInfo("onboarder.checkin_posted", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      welcomeIssue: issueNumber,
      commentId,
      commentUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.checkin_persist_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      message,
    });
  }
}

// Partner reply capture — fires from the webhook's issue_comment.created
// handler. Persists the reply verbatim into onboarding_events with
// event_type='partner_reply' and public=false. No LLM call, no GitHub
// post; this is purely signal capture for the weekly digest + NPS-style
// rollups. Comments from antfleet[bot] are filtered out at the webhook
// layer so they never reach this function.
export async function recordPartnerReply(args: {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  commentId: number;
  commentUrl: string;
  body: string;
  senderLogin: string;
  senderType: string;
}): Promise<void> {
  // Honor ONBOARDER_ENABLED for symmetry with the rest of the agent —
  // when the agent is silent in prod, the signal capture stays silent
  // too (a partner couldn't reply to a welcome that wasn't posted).
  if (!isOnboarderEnabled()) return;

  try {
    await recordOnboardingEvent({
      eventType: "partner_reply",
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      repoHash: hashRepo(args.owner, args.repo),
      modelId: null,
      prompt: null,
      toolOutput: {
        body: args.body,
        sender_login: args.senderLogin,
        sender_type: args.senderType,
        welcome_issue_number: args.issueNumber,
      },
      commentId: args.commentId,
      commentUrl: args.commentUrl,
      public: false,
    });
    logInfo("onboarder.partner_reply_recorded", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      issueNumber: args.issueNumber,
      senderLogin: args.senderLogin,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.partner_reply_persist_failed", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      issueNumber: args.issueNumber,
      message,
    });
  }
}

export { isWelcomeIssue };

// Patch Agent v1.5 — fire-and-forget onboarder events for the suggested-
// patch lifecycle. Distinct entrypoints (vs. inlining the recordOnboarding
// Event call at the worker / sweeper) so a future onboarder summary cron
// can route on patch_proposed / patch_accepted without touching upstream
// code. Both events are private; the public flag is intentionally false
// (publicReceipt at the review layer governs whether the underlying
// finding / patch is publicly visible).
//
// Errors are caught and logged — the patch already shipped; losing the
// event log is observability-only.
export type PatchProposedEventInput = {
  installationId: number;
  owner: string;
  repo: string;
  reviewId: string;
  findingId: string;
  modelId: string;
  suggestedPatch: string;
};

export async function recordPatchProposedEvent(args: PatchProposedEventInput): Promise<void> {
  if (!isOnboarderEnabled()) return;
  try {
    await recordOnboardingEvent({
      eventType: "patch_proposed",
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      repoHash: hashRepo(args.owner, args.repo),
      modelId: args.modelId,
      prompt: null,
      toolOutput: {
        review_id: args.reviewId,
        finding_id: args.findingId,
        // Capture the diff body for audit replay — same shape as the
        // posted PR comment's ```suggestion``` block contents.
        suggested_patch: args.suggestedPatch,
      },
      commentId: null,
      commentUrl: null,
      public: false,
    });
    logInfo("onboarder.patch_proposed_recorded", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      reviewId: args.reviewId,
      findingId: args.findingId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.patch_proposed_persist_failed", {
      reviewId: args.reviewId,
      findingId: args.findingId,
      message,
    });
  }
}

export type PatchAcceptedEventInput = {
  installationId: number;
  owner: string;
  repo: string;
  reviewId: string;
  findingId: string;
  modelId: string | null;
  acceptedSha: string;
  acceptanceCommentId: number | null;
  acceptanceCommentUrl: string | null;
};

export async function recordPatchAcceptedEvent(args: PatchAcceptedEventInput): Promise<void> {
  if (!isOnboarderEnabled()) return;
  try {
    await recordOnboardingEvent({
      eventType: "patch_accepted",
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      repoHash: hashRepo(args.owner, args.repo),
      modelId: args.modelId,
      prompt: null,
      toolOutput: {
        review_id: args.reviewId,
        finding_id: args.findingId,
        accepted_sha: args.acceptedSha,
      },
      commentId: args.acceptanceCommentId,
      commentUrl: args.acceptanceCommentUrl,
      public: false,
    });
    logInfo("onboarder.patch_accepted_recorded", {
      installationId: args.installationId,
      owner: args.owner,
      repo: args.repo,
      reviewId: args.reviewId,
      findingId: args.findingId,
      acceptedSha: args.acceptedSha,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("onboarder.patch_accepted_persist_failed", {
      reviewId: args.reviewId,
      findingId: args.findingId,
      message,
    });
  }
}

// Top-level cron driver — fans out check-ins for every install whose
// install_welcome row lies in the 7-to-8-day window. Logs per-candidate
// outcomes so the cron caller can include a summary in its response.
export type DailyCheckInResult = {
  attempted: number;
  posted: number;
  skipped: number;
  errors: number;
};

export async function runDailyOnboarderCheckIns(now: Date): Promise<DailyCheckInResult> {
  if (!isOnboarderEnabled()) {
    logInfo("onboarder.daily_checkin_skipped", { reason: "ONBOARDER_ENABLED not true" });
    return { attempted: 0, posted: 0, skipped: 0, errors: 0 };
  }

  const candidates = await loadCheckInCandidates(now);
  if (candidates.length === 0) {
    return { attempted: 0, posted: 0, skipped: 0, errors: 0 };
  }

  let posted = 0;
  let skipped = 0;
  let errors = 0;
  for (const c of candidates) {
    try {
      const snap = await snapshotInstallActivity(c.installationId);
      const daysElapsed = Math.round(
        (now.getTime() - c.welcomeCreatedAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      // Snapshot the row count again immediately before to detect the
      // race where another cron tick already posted between our query
      // and our call (one of the trade-offs of polling-based idempotency).
      const beforeCount = await hasOnboardingEventForInstall(
        c.installationId,
        c.owner,
        c.repo,
        "check_in_7d",
      );
      if (beforeCount) {
        skipped += 1;
        continue;
      }
      await runCheckIn({
        installationId: c.installationId,
        owner: c.owner,
        repo: c.repo,
        daysElapsed,
        reviewCount: snap.reviewCount,
        findingsAgreed: snap.findingsAgreed,
        findingsClosed: snap.findingsClosed,
        reactionsObserved: snap.reactionsObserved,
      });
      // runCheckIn writes the row on success; if it errored internally
      // it logged but didn't throw, so we can't distinguish posted vs
      // best-effort-failure here without a re-query. Cheap re-query:
      const after = await hasOnboardingEventForInstall(
        c.installationId,
        c.owner,
        c.repo,
        "check_in_7d",
      );
      if (after) posted += 1;
      else errors += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("onboarder.daily_checkin_candidate_failed", {
        installationId: c.installationId,
        owner: c.owner,
        repo: c.repo,
        message,
      });
      errors += 1;
    }
  }
  return { attempted: candidates.length, posted, skipped, errors };
}

// Re-export the event-type union so callers don't have to import from db.
export type { OnboarderEventType };
