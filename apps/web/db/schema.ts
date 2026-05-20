import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Schema follows AGENTS.md §10. Changes here are schema_version bumps —
// the column is preserved so historical rows remain interpretable. Mission 3
// added pr_comment_id/url to reviews + the finding_status table so Sweeper
// has a lifecycle row per finding to reconcile against main.

export const reviews = pgTable(
  "reviews",
  {
    reviewId: uuid("review_id").primaryKey().defaultRandom(),
    repoHash: text("repo_hash").notNull(),
    prNumber: integer("pr_number").notNull(),
    commitSha: text("commit_sha").notNull(),
    filesReviewed: text("files_reviewed").array().notNull(),
    promptVersion: text("prompt_version").notNull(),
    providerModelIds: jsonb("provider_model_ids").notNull(),
    providerResponses: jsonb("provider_responses").notNull(),
    agreementDecision: jsonb("agreement_decision").notNull(),
    timingMs: integer("timing_ms").notNull(),
    costEstimatedUsd: numeric("cost_estimated_usd", { precision: 10, scale: 4 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set by setReviewComment() after slice 4c posts the markdown comment on
    // the PR. Null when degraded/skipped or before posting succeeded.
    prCommentId: bigint("pr_comment_id", { mode: "number" }),
    prCommentUrl: text("pr_comment_url"),
    // Mission 3 slice 3-5 — the cron sweep needs to re-auth as the App
    // installation and call the GitHub REST API on the source repo to detect
    // closure and poll reactions. None of that is derivable from repo_hash
    // (sha256 is one-way). Persisted nullable so the slice 3-1 smoke rows
    // (which predate this column) don't blow up the schema migration; the
    // sweep skips findings on reviews where any of the three are null.
    installationId: bigint("installation_id", { mode: "number" }),
    owner: text("owner"),
    repo: text("repo"),
    // Mission 4 slice 4-5 — gates whether closed findings from this review
    // appear on the public /receipts page. Default false: new installs are
    // private until explicitly opted in. Design partners get the flag
    // flipped per repo (manual SQL until the v1.5 dashboard ships). Without
    // this gate, a competitor visiting /receipts could see severities,
    // categories, and finding titles for private-repo installs whose PR
    // comments are auth-walled — that is the leak this column closes.
    publicReceipt: boolean("public_receipt").notNull().default(false),
    // Mission 6 — benchmark surface. True for reviews on benchmark-class repos
    // (detected by presence of BENCHMARK.md at repo root). Surfaces the review
    // on /benchmarks regardless of close state, since benchmark replays are not
    // meant to merge and therefore never trigger Sweeper closure. Independent
    // of public_receipt: a benchmark on a public repo gets both flags; on a
    // private repo, is_benchmark is set but the row never reaches /benchmarks
    // (still gated on public_receipt = true at the query layer).
    isBenchmark: boolean("is_benchmark").notNull().default(false),
    // Mission 7 — durable review queue. The webhook handler used to call
    // reviewPR() inline inside Next.js after(); a 30-PR burst on
    // antfleet/aeon-bench (2026-05-18) produced only 10 reviews because the
    // rest hit LLM rate limits or function concurrency with nowhere to
    // retry. These columns turn the reviews row itself into the queue entry:
    // the webhook attempts the review immediately as a best-effort first
    // pass; a higher-frequency cron at /api/cron/review-retry sweeps any
    // row whose status is not 'done'.
    //
    // processingStatus state machine:
    //   pending        — row inserted, not yet attempted (rare: the webhook
    //                    crashed between insert and after())
    //   in_progress    — a worker has claimed the row; processingStartedAt
    //                    is the claim timestamp. If older than 5 minutes the
    //                    cron treats the row as stuck and re-claims.
    //   pending_retry  — last attempt failed; nextRetryAt holds the earliest
    //                    next-attempt time (exponential backoff).
    //   done           — terminal success.
    //   failed         — terminal failure (max attempts exhausted).
    processingStatus: text("processing_status").notNull().default("pending"),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    processingFinishedAt: timestamp("processing_finished_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    processingError: text("processing_error"),
  },
  (t) => [
    // Idempotency key. GitHub may re-deliver a webhook, our cron may race
    // the webhook's after(), or an operator may push the same head-sha twice;
    // the (repo_hash, pr_number, commit_sha) triple uniquely identifies a
    // single review's worth of work. Webhook handler INSERT … ON CONFLICT
    // DO NOTHING uses this index to convert duplicate deliveries into a
    // cheap no-op without spawning a second review.
    unique("reviews_idempotency_uniq").on(t.repoHash, t.prNumber, t.commitSha),
    // Index on the retry cron's hot path: scanning for non-terminal rows
    // whose nextRetryAt is due. Partial index keeps it tight.
    index("reviews_processing_lookup_idx").on(t.processingStatus, t.nextRetryAt),
  ],
);

// One row per agreed finding. Sweeper updates status when reconciliation
// detects the file has changed; reaction polling stamps last_polled_at.
// Per-finding granularity matches maintainer_reactions.finding_id below.
export const findingStatus = pgTable("finding_status", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id")
    .notNull()
    .references(() => reviews.reviewId, { onDelete: "cascade" }),
  // Position in reviews.agreement_decision.agreed[] at the moment of posting.
  findingIndex: integer("finding_index").notNull(),
  // Synthetic stable id: `${reviewIdShort}-${findingIndex}`. Used in closure
  // comments ("closed <findingId> in <sha>") and in maintainer_reactions.
  findingId: text("finding_id").notNull().unique(),
  title: text("title").notNull(),
  severity: text("severity").notNull(),
  category: text("category").notNull(),
  // open | closed | superseded
  status: text("status").notNull().default("open"),
  closureSha: text("closure_sha"),
  closureCommentId: bigint("closure_comment_id", { mode: "number" }),
  closureCommentUrl: text("closure_comment_url"),
  closureDetectedAt: timestamp("closure_detected_at", { withTimezone: true }),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const maintainerReactions = pgTable(
  "maintainer_reactions",
  {
    reactionId: uuid("reaction_id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.reviewId, { onDelete: "cascade" }),
    findingId: text("finding_id").notNull(),
    actionTaken: text("action_taken").notNull(),
    reactionAt: timestamp("reaction_at", { withTimezone: true }).notNull(),
    maintainerComment: text("maintainer_comment"),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // GitHub returns the full reaction list on every poll, so re-polling at
  // 24h/7d/30d hits the same rows repeatedly. The unique key lets slice 3-4's
  // recordMaintainerReactions use ON CONFLICT DO NOTHING for idempotent
  // upserts. The four columns together are the natural identity of a
  // reaction within the system: which review, which finding, when GitHub
  // recorded it, and what it was.
  (t) => [
    unique("maintainer_reactions_dedup").on(t.reviewId, t.findingId, t.reactionAt, t.actionTaken),
  ],
);

// Onboarder agent — owns the partner-facing lifecycle (install welcome,
// first-review summary, public-receipts opt-in, 7-day check-in). One row
// per action the agent took. Audit shape mirrors `reviews` so future
// analysis on agent reliability is queryable the same way.
//
// The `public` flag mirrors reviews.public_receipt as the surface gate
// for /activity. Onboarding events without a parent review (install
// welcome) need their own gate — we can't transitively inherit, since
// no review exists at install time.
export const onboardingEvents = pgTable("onboarding_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Discrete vocabulary, validated at the application layer:
  //   install_welcome           — Onboarder posted a welcome on install
  //   first_review_summary      — Onboarder framed the partner's first review
  //   public_receipts_enabled   — Onboarder flipped the opt-in flag
  //   public_receipts_disabled  — Onboarder reversed the opt-in
  //   check_in_7d               — Onboarder posted the 7-day reaction summary
  // Stored as text rather than a pg enum so adding a new event_type is
  // application-only; no migration required.
  eventType: text("event_type").notNull(),
  installationId: bigint("installation_id", { mode: "number" }).notNull(),
  owner: text("owner").notNull(),
  repo: text("repo").notNull(),
  repoHash: text("repo_hash").notNull(),
  // Null when the event is purely operational (flag-flip) rather than
  // model-authored. Audit symmetry with reviews.provider_model_ids.
  modelId: text("model_id"),
  // The full prompt sent to the model, when modelId is non-null. Lets
  // future analysis diff prompt evolution; mirror of the persistence
  // shape in reviews.provider_responses.
  prompt: text("prompt"),
  // Structured output the agent emitted — model tool-use result for
  // model-authored events, or a synthetic { summary } for ops events.
  toolOutput: jsonb("tool_output").notNull(),
  // GitHub artifact identifiers when the event posted a comment or
  // opened an issue. Null when the action wasn't visible on GitHub.
  commentId: bigint("comment_id", { mode: "number" }),
  commentUrl: text("comment_url"),
  // Surface gate for /activity. Default false so a fresh install's
  // actions don't appear publicly until the partner explicitly opts in.
  public: boolean("public").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Mission Phase-2 cross-repo receipts — outgoing PRs that AntFleet opens
// on third-party repos where the GitHub App is NOT installed. The sweep
// can't see those PRs via finding_status (no review row exists on the
// upstream), so this is a parallel data path. Row lifecycle: seed via
// scripts/seed-outgoing-pr.ts when the operator opens an upstream PR;
// pollOutgoingPrs() (on the cron sweep tick) reads GitHub PR state and
// transitions open → merged | closed. Merged rows surface on /receipts
// as the "cross-repo" visual class. Declined (closed-without-merge)
// rows are logged but never publicly surfaced — honest-report principle.
export const outgoingPrs = pgTable(
  "outgoing_prs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // App-level reference (no FK) to finding_status.finding_id. Finding rows
    // can be superseded by re-reviews; the outgoing PR's provenance should
    // survive that transition.
    sourceFindingId: text("source_finding_id").notNull(),
    upstreamOwner: text("upstream_owner").notNull(),
    upstreamRepo: text("upstream_repo").notNull(),
    upstreamPrNumber: integer("upstream_pr_number").notNull(),
    // Branch on the antfleet-ops fork that the PR was opened from. Helpful
    // for operator audit when reconciling a merged upstream back into the
    // bench corpus.
    branchOnFork: text("branch_on_fork").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    // open | merged | closed. "closed" means closed-without-merge (declined);
    // not surfaced publicly. "merged" is the receipt-eligible state.
    status: text("status").notNull().default("open"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergeSha: text("merge_sha"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  },
  (t) => [
    // GitHub guarantees PR numbers are unique per (owner, repo); the unique
    // index lets seed-outgoing-pr.ts upsert idempotently.
    unique("outgoing_prs_upstream_uniq").on(t.upstreamOwner, t.upstreamRepo, t.upstreamPrNumber),
  ],
);

// AntFleet investigative findings, surfaced under /agents/[address]. Distinct
// from the reviews/findingStatus pipeline: those rows are emitted by the
// two-model consensus reviewer running against a PR. agent_findings rows are
// hand-authored investigations published as a one-off URL (the first row
// being the FeeLocker selector mismatch on agent-autonomopoly). The table is
// intentionally schema-light — every column is markdown-or-string so future
// findings on other agents need no migration.
export const agentFindings = pgTable("agent_findings", {
  // Stable slug, e.g. "feelocker-selector-2026-05-18". Used in the URL when
  // we add per-finding detail pages later; for now the address page renders
  // the full body inline.
  findingId: text("finding_id").primaryKey(),
  // The agent's primary on-chain identity — usually the ERC-20 token address
  // that names the agent. Indexed via the route path /agents/[address].
  agentTokenAddress: text("agent_token_address").notNull(),
  // Human-readable repo name (e.g. "agent-autonomopoly"). Lets us cross-link
  // to AntFleet reviews on agent-<name>-bench without exposing internal ids.
  agentName: text("agent_name").notNull(),
  repoFullName: text("repo_full_name"),
  title: text("title").notNull(),
  // info | low | med | high. Free text rather than a pg enum so new levels
  // are application-only.
  severity: text("severity").notNull(),
  // Markdown body. Rendered with a small allowlist (paragraphs, lists, code,
  // links) — no raw HTML.
  summary: text("summary").notNull(),
  // Markdown — usually a short list of links and reproducible commands.
  evidence: text("evidence"),
  // Filled in after the upstream PR opens; null while the finding is still
  // unmaintained-only documentation.
  upstreamPrUrl: text("upstream_pr_url"),
  // Filled in if/when the upstream merges the fix. Null while open.
  upstreamMergedSha: text("upstream_merged_sha"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
});

export const driftSnapshots = pgTable("drift_snapshots", {
  id: text("id").primaryKey(),
  agentTokenAddress: text("agent_token_address").notNull(),
  commitSha: text("commit_sha").notNull(),
  commitTimestamp: timestamp("commit_timestamp", { withTimezone: true }).notNull(),
  driftScore: numeric("drift_score").notNull(),
  threshold: numeric("threshold").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const roastSubmissions = pgTable("roast_submissions", {
  id: text("id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  submitterEmail: text("submitter_email"),
  submitterHandle: text("submitter_handle"),
  ipHash: text("ip_hash").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  receiptId: text("receipt_id"),
  rejectionReason: text("rejection_reason"),
  // Sprint 3 — distinguishes public-form submissions from rows queued by the
  // factory watcher's pre-launch dispatcher. The runner doesn't branch on it
  // today, but the column lets /roasts/[id] and post-drafts attribute origin.
  source: text("source").notNull().default("public"),
});

// Liquid Protocol factory deploys an ERC-20 per agent launch. Each row is one
// detected TokenCreated event; the poller is idempotent on token_address.
// prelaunchStatus drives the dispatcher state machine:
//   pending → repo discovery in flight
//   benchmarking → roast_submissions row inserted, runner picking it up
//   published → roast finished, prelaunchFindingId set
//   repo_not_found → discovery exhausted, no repo within 24h window
//   benchmark_failed → runner reported terminal failure
export const factoryLaunches = pgTable("factory_launches", {
  tokenAddress: text("token_address").primaryKey(),
  deployerAddress: text("deployer_address").notNull(),
  tokenName: text("token_name"),
  tokenSymbol: text("token_symbol"),
  blockNumber: bigint("block_number", { mode: "number" }).notNull(),
  txHash: text("tx_hash").notNull(),
  deployedAt: timestamp("deployed_at", { withTimezone: true }).notNull(),
  repoFullName: text("repo_full_name"),
  repoDiscoveredAt: timestamp("repo_discovered_at", { withTimezone: true }),
  repoDiscoveryMethod: text("repo_discovery_method"),
  prelaunchStatus: text("prelaunch_status").notNull().default("pending"),
  // App-level reference (no FK) to roast_submissions.id once the dispatcher
  // hands off to the runner. Stays null until the roast publishes.
  prelaunchFindingId: text("prelaunch_finding_id"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const installations = pgTable(
  "installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    status: text("status").notNull().default("pending_approval"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  },
  (t) => [
    unique("installations_install_repo_uniq").on(t.installationId, t.repo),
    index("installations_status_idx").on(t.status),
  ],
);

// Generic cursor store for cron-style scripts. Pattern avoids per-job tables
// for tiny state. Key = job name (e.g. "poll-factory.last_block"), value =
// opaque string the job owns.
export const cronCursors = pgTable("cron_cursors", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Sprint 4 — Receipt of the week. PK on week_start so re-running the curator
// is idempotent; manual operator override (feature-finding.ts) upserts.
export const weeklyFeatures = pgTable("weekly_features", {
  // ISO date of Monday 00:00 UTC for the week this row represents.
  weekStart: date("week_start").primaryKey(),
  // FK-by-convention to agent_findings.finding_id.
  findingId: text("finding_id").notNull(),
  // 'auto' (auto-curator) or operator handle.
  curatedBy: text("curated_by").notNull(),
  rationale: text("rationale"),
  featuredAt: timestamp("featured_at", { withTimezone: true }).notNull().defaultNow(),
});

// Claim rows link by convention to factory_launches.token_address; /api/claim
// enforces existence because the first dispatcher tick may not have persisted
// the launch row yet.
export const agentClaims = pgTable("agent_claims", {
  id: text("id").primaryKey(),
  tokenAddress: text("token_address").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  // EIP-191 personal_sign over the message defined in /api/claim. Stored for
  // audit so a third party can reproduce the recover.
  claimerSignature: text("claimer_signature").notNull(),
  // Address recovered from the signature. Verified against
  // factory_launches.deployer_address at write time; persisted so reviews can
  // re-check without re-signing.
  claimerAddress: text("claimer_address").notNull(),
  // 'pending' | 'verified' | 'rejected'.
  status: text("status").notNull().default("pending"),
  rejectionReason: text("rejection_reason"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
});

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type FindingStatus = typeof findingStatus.$inferSelect;
export type NewFindingStatus = typeof findingStatus.$inferInsert;
export type MaintainerReaction = typeof maintainerReactions.$inferSelect;
export type NewMaintainerReaction = typeof maintainerReactions.$inferInsert;
export type OnboardingEvent = typeof onboardingEvents.$inferSelect;
export type NewOnboardingEvent = typeof onboardingEvents.$inferInsert;
export type OutgoingPr = typeof outgoingPrs.$inferSelect;
export type NewOutgoingPr = typeof outgoingPrs.$inferInsert;
export type AgentFinding = typeof agentFindings.$inferSelect;
export type NewAgentFinding = typeof agentFindings.$inferInsert;
export type DriftSnapshot = typeof driftSnapshots.$inferSelect;
export type NewDriftSnapshot = typeof driftSnapshots.$inferInsert;
export type RoastSubmission = typeof roastSubmissions.$inferSelect;
export type NewRoastSubmission = typeof roastSubmissions.$inferInsert;
export type FactoryLaunch = typeof factoryLaunches.$inferSelect;
export type NewFactoryLaunch = typeof factoryLaunches.$inferInsert;
export type Installation = typeof installations.$inferSelect;
export type NewInstallation = typeof installations.$inferInsert;
export type CronCursor = typeof cronCursors.$inferSelect;
export type NewCronCursor = typeof cronCursors.$inferInsert;
export type AgentClaim = typeof agentClaims.$inferSelect;
export type NewAgentClaim = typeof agentClaims.$inferInsert;
export type WeeklyFeature = typeof weeklyFeatures.$inferSelect;
export type NewWeeklyFeature = typeof weeklyFeatures.$inferInsert;
