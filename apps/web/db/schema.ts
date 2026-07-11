import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    // Patch Agent v1.5 — patch generation cost tracked separately from the
    // review's reviewer-fleet cost. Drawdown stays at REVIEW_PRICE_USDC; this
    // column is observability-only for future re-pricing analysis. Nullable
    // because pre-Patch-Agent reviews and flag-off reviews never set it.
    costPatchUsd: numeric("cost_patch_usd", { precision: 10, scale: 4 }),
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
    // /receipts and /receipts.rss filter on public_receipt=true before
    // joining finding_status. Migration 0037.
    index("reviews_public_receipt_idx").on(t.publicReceipt),
  ],
);

// One row per agreed finding. Sweeper updates status when reconciliation
// detects the file has changed; reaction polling stamps last_polled_at.
// Per-finding granularity matches maintainer_reactions.finding_id below.
export const findingStatus = pgTable(
  "finding_status",
  {
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
    label: text("label").default("blocking"),
    category: text("category").notNull(),
    // open | closed | superseded
    status: text("status").notNull().default("open"),
    // Win 2 (migration 0051) — tier that produced this lifecycle row.
    // 'consensus'    → unanimous-gate finding, finding_index into
    //                  agreement_decision.agreed[] (the index-coupled space).
    // 'single_model' → shadow-tier finding, finding_index into
    //                  agreement_decision.singleModelTier[], finding_id in the
    //                  distinct `-s` namespace. NOT NULL DEFAULT 'consensus'
    //                  so every pre-0051 row is a consensus row. Every reader
    //                  that resolves finding_index against agreed[] filters on
    //                  source='consensus'; the precision metric segments by it.
    source: text("source").notNull().default("consensus"),
    // Build B (migration 0052) — two_of_three graduation marker. A single
    // independent 3rd-model (GLM 5.2) confirm/reject call adjudicates each
    // source='single_model' shadow finding; corroborated=true = graduated to
    // the two_of_three sub-tier. Stays INSIDE the source='single_model' tier
    // (never flips source to 'consensus'), so every public reader-guard that
    // already excludes source='single_model' also excludes corroborated rows —
    // no new public exposure. NOT NULL DEFAULT false so pre-0052 rows backfill
    // to uncorroborated. The precision metric segments dismiss-rate by it.
    corroborated: boolean("corroborated").notNull().default(false),
    closureSha: text("closure_sha"),
    closureCommentId: bigint("closure_comment_id", { mode: "number" }),
    closureCommentUrl: text("closure_comment_url"),
    closureDetectedAt: timestamp("closure_detected_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Patch Agent v1.5 — suggested-patch lifecycle. All fields nullable so the
    // flag-off path produces byte-identical rows to pre-sprint behavior.
    // suggestedPatch holds the unified-diff text that was rendered inside the
    // ```suggestion block; capped at 20 lines pre-persist. patchModelId names
    // the provider whose patch shipped (always Opus in v1 — patch-gate.ts
    // hard-codes the deterministic winner). patchSkipReason explains why no
    // patch shipped: one of models_disagreed | outside_diff_hunk |
    // generation_error | disabled | size_cap. patchAcceptedAt + Sha land
    // when the sweeper's patch-acceptance pass detects the suggestion in HEAD.
    suggestedPatch: text("suggested_patch"),
    patchProposedAt: timestamp("patch_proposed_at", { withTimezone: true }),
    patchModelId: text("patch_model_id"),
    patchAcceptedAt: timestamp("patch_accepted_at", { withTimezone: true }),
    patchAcceptedSha: text("patch_accepted_sha"),
    patchSkipReason: text("patch_skip_reason"),
    // Patch Agent v1.6 — click-to-apply lane. patchReviewCommentId / Url
    // track the PR review-comment artifact posted alongside the issue
    // comment when PATCH_AGENT_CLICK_APPLY_ENABLED is on. Idempotency on
    // review-worker retry is enforced via `WHERE patch_review_comment_id
    // IS NULL`. patchApplyClickedAt is set by the sweeper's
    // runPatchReviewCommentAcceptancePass when GitHub's "Commit suggestion"
    // button fires (distinct from patchAcceptedAt, which also covers
    // manual commits whose content happens to match the suggestion).
    patchReviewCommentId: bigint("patch_review_comment_id", { mode: "number" }),
    patchReviewCommentUrl: text("patch_review_comment_url"),
    patchReviewProposedAt: timestamp("patch_review_proposed_at", { withTimezone: true }),
    patchApplyClickedAt: timestamp("patch_apply_clicked_at", { withTimezone: true }),
    // Eval Phase 0 — dual-candidate persistence. Per-provider patch candidates
    // so eval-harness step 3 can ETL (category x severity x proposing_model x
    // accepted). Original suggested_patch + patch_model_id columns preserved for
    // backward compat; new writes populate BOTH old + new.
    suggestedPatchOpus: text("suggested_patch_opus"),
    suggestedPatchGpt5: text("suggested_patch_gpt5"),
    patchShipped: text("patch_shipped"),
    patchSelector: text("patch_selector"),
    // Patch Agent cost instrumentation (migration 0029) — per-finding token
    // spend for the two patch-proposal calls, split by provider. Captured from
    // the SDK usage blocks and written by recordPatchDecisions alongside the
    // patch candidates. Nullable: a finding whose providers made no billable
    // call (precheck skip, generation error) leaves the relevant side NULL,
    // which the reconciliation cron treats as "measure via heuristic". The
    // aggregate USD cost lives on reviews.cost_patch_usd, not here.
    inputTokensOpus: integer("input_tokens_opus"),
    outputTokensOpus: integer("output_tokens_opus"),
    inputTokensGpt5: integer("input_tokens_gpt5"),
    outputTokensGpt5: integer("output_tokens_gpt5"),
    // Patch Agent observability (migration 0031). Provider rationale is
    // debug/operator data only; public comments continue to render patches,
    // not decline explanations.
    patchRationaleOpus: text("patch_rationale_opus"),
    patchRationaleGpt5: text("patch_rationale_gpt5"),
    // Patch Agent diagnostic surface (migration 0035). Per-side orchestrator
    // skip reason, mirroring ProviderPatchProposal.skipReason. Lets operators
    // distinguish a silent throw/timeout (generation_error) from a clean
    // policy decline (model returned patch=null with a rationale) without
    // cross-referencing token + rationale columns. The aggregate
    // patch_skip_reason column above continues to record the gate-level
    // outcome (models_disagreed etc.); these record the per-side raw reason.
    patchSkipReasonOpus: text("patch_skip_reason_opus"),
    patchSkipReasonGpt5: text("patch_skip_reason_gpt5"),
    // Retraction surface (migration 0030). When the unanimous gate produces a
    // false positive, the operator retracts the finding: the /anatomy page drops
    // its JSON-LD + adds noindex and renders a retraction notice instead. All
    // nullable — retractedAt IS NULL is the normal (non-retracted) state and
    // renders exactly as before. retractionReason is shown on the notice when
    // set; retractionEmail records the requestor (if a maintainer asked) for the
    // audit trail and is never rendered publicly.
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
    retractionReason: text("retraction_reason"),
    retractionEmail: text("retraction_email"),
  },
  (t) => [
    // /receipts page joins finding_status -> reviews filtering on
    // status='closed' AND public_receipt=true. The review_id FK is the
    // join key; status + closure_detected_at indexes the order-by used
    // for closed-finding feeds. Migration 0037.
    index("finding_status_review_id_idx").on(t.reviewId),
    index("finding_status_status_closure_idx").on(t.status, t.closureDetectedAt),
    // Natural-key uniqueness (migration 0038, optional hardening — the
    // runtime path uses preselect-then-conflict-on-finding_id so it
    // does NOT depend on this constraint being applied). Win 2 (migration
    // 0051) widened the key to include `source` so a shadow row
    // (source='single_model', finding_index=0) does not collide with a
    // consensus row (source='consensus', finding_index=0) of the same review.
    uniqueIndex("finding_status_review_index_uniq").on(t.reviewId, t.findingIndex, t.source),
  ],
);

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
    // Step 0.5 migration 0049 — attribution (both nullable, dark).
    // reactor_login: populated by the reaction poll mapper (reactions.ts).
    // author_association: NOT available from the reaction poll API; reserved
    // for the dismiss-reply ingestion path (Step 0.5 item 4) which reads it
    // from issue_comment.created webhook payload.
    reactorLogin: text("reactor_login"),
    authorAssociation: text("author_association"),
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
    // open | merged | closed | closed_absorbed.
    // "closed" = closed-without-merge (declined), not surfaced publicly.
    // "merged" and "closed_absorbed" are receipt-eligible states.
    status: text("status").notNull().default("open"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergeSha: text("merge_sha"),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    // Absorbed-inline closure detection (migration 0026).
    // closureMethod: merged | absorbed_inline | declined | stale_timeout
    closureMethod: text("closure_method"),
    // Upstream commit SHA that applied the fix (merge SHA for merged, or
    // the independent commit for absorbed_inline).
    closureSha: text("closure_sha"),
    closureDetectedAt: timestamp("closure_detected_at", { withTimezone: true }),
    // LLM-judge confidence score: 0.0..1.0
    closureConfidence: real("closure_confidence"),
    // LLM-judge reasoning text for audit
    closureNotes: text("closure_notes"),
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
export const agentFindings = pgTable(
  "agent_findings",
  {
    // Stable slug, e.g. "feelocker-selector-2026-05-18". Used in the URL when
    // we add per-finding detail pages later; for now the address page renders
    // the full body inline.
    findingId: text("finding_id").primaryKey(),
    // The agent's primary on-chain identity — usually the ERC-20 token address
    // that names the agent. Indexed via the route path /agents/[address].
    agentTokenAddress: text("agent_token_address").notNull(),
    // Human-readable repo name (e.g. "agent-autonomopoly").
    agentName: text("agent_name").notNull(),
    // Upstream/full repository identity for API filters and receipts, when
    // known. Do not use this for benchmark review joins; some rows point at the
    // upstream repo while others were seeded from the bench mirror.
    repoFullName: text("repo_full_name"),
    // Short repo name stored in reviews.repo for this agent's benchmark mirror,
    // e.g. "aeon-bench" or "agent-autonomopoly-bench".
    benchRepoName: text("bench_repo_name"),
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
  },
  (t) => [
    index("agent_findings_public_page_idx").on(t.publishedAt, t.findingId),
    index("agent_findings_agent_page_idx").on(
      sql`lower(${t.agentTokenAddress})`,
      t.publishedAt,
      t.findingId,
    ),
    index("agent_findings_repo_page_idx").on(
      sql`lower(${t.repoFullName})`,
      t.publishedAt,
      t.findingId,
    ),
    index("agent_findings_severity_page_idx").on(t.severity, t.publishedAt, t.findingId),
  ],
);

export const driftSnapshots = pgTable(
  "drift_snapshots",
  {
    id: text("id").primaryKey(),
    agentTokenAddress: text("agent_token_address").notNull(),
    commitSha: text("commit_sha").notNull(),
    commitTimestamp: timestamp("commit_timestamp", { withTimezone: true }).notNull(),
    driftScore: numeric("drift_score").notNull(),
    threshold: numeric("threshold").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("drift_snapshots_agent_commit_idx").on(
      sql`lower(${t.agentTokenAddress})`,
      t.commitTimestamp,
      t.id,
    ),
    index("drift_snapshots_agent_observed_idx").on(
      sql`lower(${t.agentTokenAddress})`,
      t.observedAt,
      t.id,
    ),
  ],
);

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
export const factoryLaunches = pgTable(
  "factory_launches",
  {
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
  },
  (t) => [
    index("factory_launches_published_token_idx").on(
      t.prelaunchStatus,
      sql`lower(${t.tokenAddress})`,
    ),
    index("factory_launches_directory_idx").on(t.prelaunchStatus, t.deployedAt, t.tokenAddress),
  ],
);

// Status vocabulary (text, application-validated):
//   Legacy gate flow (pre-paywall, webhook-created rows):
//     pending_approval | approved | rejected
//   Agent paywall flow (wallet-bound, agent-created rows):
//     pending_binding   — row exists, awaiting EIP-191 binding signature
//     awaiting_deposit  — wallet bound, awaiting USDC deposit on Base
//     active            — channel funded, ready to receive reviews
// Legacy rows and paywall rows share the same table because they share the
// same downstream consumer (the webhook drawdown gate), which checks
// legacy_partner first and only falls through to channel balance for
// agent-onboarded installs.
//
// installation_id / owner / repo are nullable because an agent creates the
// row before installing the GitHub App; the webhook links them up on the
// first delivery for the bound wallet's install. Legacy rows always have
// all three populated.
export const installations = pgTable(
  "installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" }),
    owner: text("owner"),
    repo: text("repo"),
    status: text("status").notNull().default("pending_approval"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    // Lowercased 0x... Base address that signed the binding challenge.
    // Same address must own the channel and authorize the GitHub install.
    walletAddress: text("wallet_address"),
    // EIP-191 personal_sign of "AntFleet binding: {id} {wallet} {iso}".
    // Stored so a third party can reproduce the recover without re-signing.
    walletProofSignature: text("wallet_proof_signature"),
    walletBoundAt: timestamp("wallet_bound_at", { withTimezone: true }),
    // Grandfathered partners onboarded under the old human-gated flow keep
    // getting reviews without paying. Backfilled true for every row whose
    // status was 'approved' at the migration boundary.
    legacyPartner: boolean("legacy_partner").notNull().default(false),
    // Patch Agent v1.5 — per-install override for the PATCH_AGENT_ENABLED
    // env flag. NULL = inherit env default (false in prod, true in dev).
    // Non-null = force-on/off for this install regardless of env. Used to
    // canary one test install before flipping the env-wide default.
    patchAgentEnabled: boolean("patch_agent_enabled"),
    // Patch Agent v1.6 — per-install override for the
    // PATCH_AGENT_CLICK_APPLY_ENABLED env flag. Same pattern as
    // patchAgentEnabled. Canary on AntFleet/aeon-bench before flipping
    // env-wide.
    patchAgentClickApplyEnabled: boolean("patch_agent_click_apply_enabled"),
    // Coordinated disclosure gate. Operator-managed only: true means HIGH /
    // CRITICAL findings for this repo enter the private disclosure state
    // machine instead of surfacing immediately. Default false so existing
    // installs keep byte-identical public receipt behavior until explicitly
    // classified.
    isLiveProtocol: boolean("is_live_protocol").notNull().default(false),
    // Step 0.5 migration 0050 — per-install precision-feedback override.
    // NULL = inherit ANTFLEET_PRECISION_FEEDBACK env default (OFF).
    // Non-null = force-on/off for this install, regardless of env. Used to
    // canary one install (e.g. aeon-bench) before flipping env-wide.
    precisionFeedbackEnabled: boolean("precision_feedback_enabled"),
    // Win 2 migration 0051 — per-install single-model shadow tier override.
    // NULL = inherit ANTFLEET_SINGLE_MODEL_TIER env default (OFF).
    // Non-null = force-on/off for this install, regardless of env. Used to
    // canary one install (e.g. aeon-bench) before flipping env-wide.
    singleModelTierEnabled: boolean("single_model_tier_enabled"),
    // Build B migration 0052 — per-install 3rd-model adjudication override.
    // NULL = inherit ANTFLEET_THIRD_MODEL_ADJUDICATION env default (OFF).
    // Non-null = force-on/off for this install, regardless of env. Layers
    // UNDER single_model_tier_enabled: adjudication only runs on a shadow tier
    // that was itself enabled for the install.
    thirdModelAdjudicationEnabled: boolean("third_model_adjudication_enabled"),
  },
  (t) => [
    unique("installations_install_repo_uniq").on(t.installationId, t.repo),
    index("installations_status_idx").on(t.status),
    index("installations_wallet_address_idx").on(t.walletAddress),
    index("installations_live_protocol_idx").on(t.isLiveProtocol),
  ],
);

// Server-issued single-use nonces for the on-demand review endpoint
// (POST /api/v1/installations/{id}/review). The /bind endpoint can use
// a stateless challenge because binding is one-shot per install; review
// is repeating, so we mint a fresh challenge_id per call and mark it
// used_at on redemption so signatures can't be replayed.
export const reviewChallenges = pgTable(
  "review_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationRowId: uuid("installation_row_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedForReviewId: uuid("used_for_review_id").references(() => reviews.reviewId, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("review_challenges_installation_idx").on(t.installationRowId),
    index("review_challenges_expired_idx").on(t.expiresAt),
  ],
);

// One channel per installation. Agent-onboarded installs always have one;
// legacy_partner rows have no channel and bypass the balance check at the
// drawdown gate. balanceUsdc is mutated only by atomic UPDATE ... WHERE
// balance >= price (drawdown) or UPDATE ... SET balance = balance + amount
// (deposit), so concurrent webhooks for the same channel cannot overdraw.
export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    walletAddress: text("wallet_address").notNull(),
    balanceUsdc: numeric("balance_usdc", { precision: 18, scale: 6 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Audit-only conveniences; the full ledger lives in `payments`.
    lastDepositTxHash: text("last_deposit_tx_hash"),
    lastDrawdownAt: timestamp("last_drawdown_at", { withTimezone: true }),
  },
  (t) => [
    unique("channels_installation_id_uniq").on(t.installationId),
    index("channels_wallet_address_idx").on(t.walletAddress),
  ],
);

// Append-only ledger. type='deposit' rows reference an on-chain USDC
// Transfer; type='drawdown' rows reference a single review and have no
// tx_hash. The unique index on (chain_id, tx_hash) makes deposit detection
// idempotent — the /deposit fast path and the scan-deposits cron may both
// observe the same Transfer, and the second INSERT becomes a no-op.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    // 'deposit' | 'drawdown' — enforced by a CHECK constraint at the DDL
    // level so future variants (e.g. 'refund') are application-only.
    type: text("type").notNull(),
    txHash: text("tx_hash"),
    chainId: integer("chain_id").notNull().default(8453),
    fromAddress: text("from_address").notNull(),
    amountUsdc: numeric("amount_usdc", { precision: 18, scale: 6 }).notNull(),
    blockNumber: bigint("block_number", { mode: "number" }),
    reviewId: uuid("review_id").references(() => reviews.reviewId, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_tx_hash_uniq")
      .on(t.chainId, t.txHash)
      .where(sql`${t.txHash} IS NOT NULL`),
    index("payments_channel_id_idx").on(t.channelId),
  ],
);

// Generic cursor store for cron-style scripts. Pattern avoids per-job tables
// for tiny state. Key = job name (e.g. "poll-factory.last_block"), value =
// opaque string the job owns.
// API async-default — review job queue. POST /api/v1/installations/{id}/review
// enqueues a row here and returns 202 + jobId immediately. The worker picks it
// up via waitUntil(); a safety-net cron re-triggers orphan/stuck jobs. Generic
// naming: every v1 review caller shares this queue.
export const reviewJobs = pgTable(
  "review_jobs",
  {
    jobId: text("job_id").primaryKey(),
    installationId: text("installation_id").notNull(),
    walletAddress: text("wallet_address").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    prNumber: integer("pr_number"),
    sha: text("sha"),
    idempotencyKey: text("idempotency_key"),
    status: text("status").notNull().default("queued"),
    failureMode: text("failure_mode"),
    failureMessage: text("failure_message"),
    result: jsonb("result"),
    debitPaymentId: uuid("debit_payment_id").references(() => payments.id),
    refundPaymentId: uuid("refund_payment_id").references(() => payments.id),
    callerWallet: text("caller_wallet"),
    paymentRail: text("payment_rail").notNull().default("channel"),
    x402PayTo: text("x402_pay_to"),
    x402PaymentPayload: jsonb("x402_payment_payload"),
    x402ValidAfter: timestamp("x402_valid_after", { withTimezone: true }),
    x402ValidBefore: timestamp("x402_valid_before", { withTimezone: true }),
    x402ReviewId: text("x402_review_id"),
    x402SettlementStatus: text("x402_settlement_status"),
    x402SettlementResponse: jsonb("x402_settlement_response"),
    acpJobId: text("acp_job_id"),
    acpClientWallet: text("acp_client_wallet"),
    acpTargetKey: text("acp_target_key"),
    acpRequestPayload: jsonb("acp_request_payload"),
    acpReviewId: text("acp_review_id"),
    acpBudgetStatus: text("acp_budget_status"),
    acpBudgetResponse: jsonb("acp_budget_response"),
    acpBudgetAttempts: integer("acp_budget_attempts").notNull().default(0),
    acpBudgetUpdatedAt: timestamp("acp_budget_updated_at", { withTimezone: true }),
    acpSubmitStatus: text("acp_submit_status"),
    acpSubmitResponse: jsonb("acp_submit_response"),
    acpSubmittedAt: timestamp("acp_submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("review_jobs_status_started_idx").on(t.status, t.startedAt),
    index("review_jobs_installation_idx").on(t.installationId, t.createdAt),
    unique("idx_review_jobs_rail_installation_idempotency_unique").on(
      t.paymentRail,
      t.installationId,
      t.idempotencyKey,
    ),
    index("idx_review_jobs_caller_wallet").on(t.callerWallet),
    index("idx_review_jobs_payment_rail_created").on(t.paymentRail, t.createdAt),
    index("idx_review_jobs_x402_pay_to").on(t.x402PayTo),
    index("idx_review_jobs_x402_review_id").on(t.x402ReviewId),
    index("idx_review_jobs_x402_settlement_status").on(t.x402SettlementStatus),
    uniqueIndex("idx_review_jobs_acp_job_id_unique")
      .on(t.acpJobId)
      .where(sql`${t.paymentRail} = 'acp' AND ${t.acpJobId} IS NOT NULL`),
    uniqueIndex("idx_review_jobs_acp_target_key_unique")
      .on(t.acpTargetKey)
      .where(sql`${t.paymentRail} = 'acp' AND ${t.acpTargetKey} IS NOT NULL`),
    index("idx_review_jobs_acp_review_id")
      .on(t.acpReviewId)
      .where(sql`${t.paymentRail} = 'acp' AND ${t.acpReviewId} IS NOT NULL`),
    index("idx_review_jobs_acp_budget_status")
      .on(t.acpBudgetStatus)
      .where(sql`${t.paymentRail} = 'acp'`),
    index("idx_review_jobs_acp_submit_status")
      .on(t.acpSubmitStatus)
      .where(sql`${t.paymentRail} = 'acp'`),
  ],
);

export const acpProviderEvents = pgTable(
  "acp_provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventKey: text("event_key").notNull(),
    acpJobId: text("acp_job_id"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    failureMessage: text("failure_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idx_acp_provider_events_event_key_unique").on(t.eventKey),
    index("idx_acp_provider_events_status_next_retry").on(t.status, t.nextRetryAt),
    index("idx_acp_provider_events_acp_job").on(t.acpJobId),
  ],
);

export const x402ScanClaims = pgTable(
  "x402_scan_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorizationKey: text("authorization_key").notNull(),
    callerWallet: text("caller_wallet").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    headSha: text("head_sha"),
    status: text("status").notNull().default("claimed"),
    settlementResponse: jsonb("settlement_response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("x402_scan_claims_authorization_key_uniq").on(t.authorizationKey),
    index("x402_scan_claims_wallet_created_idx").on(t.callerWallet, t.createdAt),
    index("x402_scan_claims_repo_created_idx").on(t.repoOwner, t.repoName, t.createdAt),
    index("x402_scan_claims_status_idx").on(t.status),
  ],
);

export const x402ReviewClaims = pgTable(
  "x402_review_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorizationKey: text("authorization_key").notNull(),
    callerWallet: text("caller_wallet").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    prNumber: integer("pr_number"),
    headSha: text("head_sha"),
    jobId: text("job_id"),
    status: text("status").notNull().default("claimed"),
    settlementResponse: jsonb("settlement_response"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("x402_review_claims_authorization_key_uniq").on(t.authorizationKey),
    index("x402_review_claims_wallet_created_idx").on(t.callerWallet, t.createdAt),
    index("x402_review_claims_repo_created_idx").on(t.repoOwner, t.repoName, t.createdAt),
    index("x402_review_claims_status_idx").on(t.status),
  ],
);

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

// AI Scorecard — immutable weekly snapshots of provider-comparison stats.
// One row per week, keyed on the week-ending Sunday (YYYY-MM-DD). Payload
// is the full aggregated numbers produced by lib/scorecard.ts. Once published,
// snapshots never change even if underlying data evolves.
export const scorecardSnapshots = pgTable("scorecard_snapshots", {
  yyyyMmDd: text("yyyy_mm_dd").primaryKey(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  generatorVersion: text("generator_version").notNull(),
  payload: jsonb("payload").notNull(),
});

// Daybreak-inspired side table for the reachability gate + patch verifier.
// One INSERT per stage invocation; never UPDATEd, so there's no contention
// with the recordPatchDecisions UPDATE path on finding_status. Adding new
// stage names is application-only (stage column is free-text text).
//
// Migration 0041 ships the DDL. Until applied, code paths that write to
// this table are gated behind ANTFLEET_REACHABILITY_GATE and
// ANTFLEET_PATCH_VERIFY (both default OFF in prod) — schema-presence is
// part of the bench-on / prod-off contract.
export const reviewGateOutcomes = pgTable(
  "review_gate_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.reviewId, { onDelete: "cascade" }),
    findingId: text("finding_id"),
    stage: text("stage").notNull(),
    verdict: text("verdict").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    modelId: text("model_id"),
    reviewAttempt: integer("review_attempt").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("review_gate_outcomes_review_idx").on(t.reviewId),
    index("review_gate_outcomes_stage_verdict_idx").on(t.stage, t.verdict),
    index("review_gate_outcomes_review_finding_idx").on(t.reviewId, t.findingId),
    // Idempotency for the repro_verify side-table (migration 0053, FIX G): at
    // most one repro_verify row per (review_id, finding_id). PARTIAL — scoped to
    // WHERE stage='repro_verify' so it does NOT constrain the existing
    // reachability / patch_verify stages, which legitimately write multiple rows
    // per (review, finding) across attempts. SAFE to add with no backfill:
    // repro_verify is a brand-new stage value with zero pre-existing rows. The
    // record phase's onConflictDoNothing targets this index.
    uniqueIndex("review_gate_outcomes_repro_verify_uniq")
      .on(t.reviewId, t.findingId)
      .where(sql`${t.stage} = 'repro_verify'`),
  ],
);

// Public receipt validation evidence bundle. One row per finding/attempt,
// fed additively by the Daybreak reachability and patch-verify gates. Kept
// separate from finding_status per the side-table deferral gate: this is
// public-proof material, not lifecycle state.
export const findingValidationEvidenceBundles = pgTable(
  "finding_validation_evidence_bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.reviewId, { onDelete: "cascade" }),
    findingId: text("finding_id").notNull(),
    reviewAttempt: integer("review_attempt").notNull().default(1),
    affectedSha: text("affected_sha").notNull(),
    pocSnippet: jsonb("poc_snippet"),
    reproductionCommand: jsonb("reproduction_command"),
    callPathTrace: jsonb("call_path_trace"),
    bundleStatus: text("bundle_status").notNull().default("empty"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("finding_validation_evidence_bundle_uniq").on(t.reviewId, t.findingId, t.reviewAttempt),
    index("finding_validation_evidence_bundle_finding_idx").on(t.findingId),
    index("finding_validation_evidence_bundle_status_idx").on(t.bundleStatus),
  ],
);

// Daybreak primitive #3 — durable per-repo threat model. One row per repo,
// not per installation, so repeated reviews accumulate and reuse the same
// attack-surface memory. Public rendering reads only public_model and only
// when public_access = 'public'.
export const repoThreatModel = pgTable(
  "repo_threat_model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoHash: text("repo_hash").notNull().unique(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    version: integer("version").notNull().default(1),
    model: jsonb("model").notNull(),
    publicModel: jsonb("public_model").notNull().default({}),
    provenance: jsonb("provenance").notNull().default({}),
    generatorModelId: text("generator_model_id"),
    lastReviewedSha: text("last_reviewed_sha").notNull(),
    entryPointsRefreshedSha: text("entry_points_refreshed_sha"),
    trustBoundariesRefreshedSha: text("trust_boundaries_refreshed_sha"),
    sinksRefreshedSha: text("sinks_refreshed_sha"),
    secretsSurfaceRefreshedSha: text("secrets_surface_refreshed_sha"),
    criticalAssetsRefreshedSha: text("critical_assets_refreshed_sha"),
    refreshCount: integer("refresh_count").notNull().default(1),
    publicAccess: text("public_access").notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("repo_threat_model_owner_repo_idx").on(sql`lower(${t.owner})`, sql`lower(${t.repo})`),
    index("repo_threat_model_public_access_idx").on(t.publicAccess),
  ],
);

export const sarifIngestTokenUse = pgTable(
  "sarif_ingest_token_use",
  {
    jti: text("jti").primaryKey(),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    repo: text("repo").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sarif_ingest_token_use_used_at_idx").on(t.usedAt)],
);

export const sarifImportBatch = pgTable(
  "sarif_import_batch",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: bigint("installation_id", { mode: "number" }),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    repoHash: text("repo_hash").notNull(),
    sourceTool: text("source_tool").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRevision: text("source_revision"),
    sourceUrl: text("source_url"),
    fileBlobRef: text("file_blob_ref"),
    ingestTokenJti: text("ingest_token_jti"),
    status: text("status").notNull().default("pending"),
    totalClaims: integer("total_claims").notNull().default(0),
    realCount: integer("real_count").notNull().default(0),
    falsePositiveCount: integer("false_positive_count").notNull().default(0),
    inconclusiveCount: integer("inconclusive_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sarif_import_batch_repo_idx").on(t.repoHash, t.createdAt),
    index("sarif_import_batch_status_idx").on(t.status, t.createdAt),
  ],
);

export const sarifFinding = pgTable(
  "sarif_finding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => sarifImportBatch.id, { onDelete: "cascade" }),
    externalFingerprint: text("external_fingerprint").notNull(),
    sourceTool: text("source_tool").notNull(),
    ruleId: text("rule_id").notNull(),
    ruleName: text("rule_name"),
    level: text("level").notNull().default("warning"),
    severity: text("severity").notNull().default("medium"),
    message: text("message").notNull(),
    artifactUri: text("artifact_uri").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    originalClaim: jsonb("original_claim").notNull(),
    normalizedClaim: jsonb("normalized_claim").notNull(),
    validationVerdict: text("validation_verdict").notNull().default("pending"),
    confirmationVerdict: text("confirmation_verdict"),
    reachabilityVerdict: text("reachability_verdict"),
    patchVerifyVerdict: text("patch_verify_verdict"),
    closureReceipt: jsonb("closure_receipt"),
    linkedFindingStatusId: uuid("linked_finding_status_id").references(() => findingStatus.id, {
      onDelete: "set null",
    }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sarif_finding_batch_idx").on(t.batchId),
    index("sarif_finding_validation_idx").on(t.validationVerdict, t.processedAt),
    uniqueIndex("sarif_finding_batch_fingerprint_uniq").on(t.batchId, t.externalFingerprint),
  ],
);

// Coordinated disclosure state per finding. Public receipt eligibility is
// derived from this row plus reviews.public_receipt: published findings are
// public; non-disclosure findings inherit the legacy review-level flag.
// Active embargo states remain private even when the source review was public.
export const findingDisclosure = pgTable(
  "finding_disclosure",
  {
    findingId: text("finding_id")
      .primaryKey()
      .references(() => findingStatus.findingId, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.reviewId, { onDelete: "cascade" }),
    state: text("state").notNull().default("none"),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull().defaultNow(),
    embargoExpiresAt: timestamp("embargo_expires_at", { withTimezone: true }),
    cveId: text("cve_id"),
    cveRequestedAt: timestamp("cve_requested_at", { withTimezone: true }),
    ghsaId: text("ghsa_id"),
    ghsaHtmlUrl: text("ghsa_html_url"),
    ghsaPublishedAt: timestamp("ghsa_published_at", { withTimezone: true }),
    ghsaReservationToken: text("ghsa_reservation_token"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    forcedBy: text("forced_by"),
    maintainerUrlCiphertext: text("maintainer_url_ciphertext"),
    maintainerUrlLogId: text("maintainer_url_log_id"),
    advisoryDraft: text("advisory_draft"),
    advisoryDraftUpdatedAt: timestamp("advisory_draft_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("finding_disclosure_review_idx").on(t.reviewId),
    index("finding_disclosure_state_idx").on(t.state),
    index("finding_disclosure_embargo_expires_idx").on(t.embargoExpiresAt),
  ],
);

// Daybreak follow-up — repo cyber tier (migration 0048). Stricter posture
// for verified defenders / sensitive systems. Repo-scoped, not install-
// scoped: multiple installs of the same upstream repo share the tier and
// the strictest-wins property is enforced by having a single row keyed on
// lowercased (owner, repo).
//
// Reads always go through lib/cyber-tier.ts (flag-gated via
// ANTFLEET_CYBER_TIER). Writes are ONLY allowed through the operator
// admin module (lib/cyber-tier-admin.ts) — webhook, install flow, and
// any future self-service settings UI are forbidden. The grep-test in
// lib/cyber-tier-admin.test.ts enforces the single import.
export const cyberTierEnum = pgEnum("cyber_tier", ["default", "cyber"]);

export const repoTier = pgTable(
  "repo_tier",
  {
    ownerLc: text("owner_lc").notNull(),
    repoLc: text("repo_lc").notNull(),
    tier: cyberTierEnum("tier").notNull().default("default"),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerLc, t.repoLc] }), index("repo_tier_tier_idx").on(t.tier)],
);

export const repoTierChangeLog = pgTable(
  "repo_tier_change_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerLc: text("owner_lc").notNull(),
    repoLc: text("repo_lc").notNull(),
    oldTier: cyberTierEnum("old_tier").notNull(),
    newTier: cyberTierEnum("new_tier").notNull(),
    reason: text("reason").notNull(),
    actor: text("actor").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("repo_tier_change_log_repo_idx").on(t.ownerLc, t.repoLc, t.changedAt),
    // Global latest-change index for scorecard staleness check.
    // (Architect audit pass-10, severity medium.)
    index("repo_tier_change_log_changed_at_idx").on(t.changedAt),
  ],
);

export const findingDisclosureLog = pgTable(
  "finding_disclosure_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: text("finding_id")
      .notNull()
      .references(() => findingDisclosure.findingId, { onDelete: "cascade" }),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    reason: text("reason").notNull(),
    atSha: text("at_sha").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("finding_disclosure_log_finding_idx").on(t.findingId),
    index("finding_disclosure_log_created_idx").on(t.createdAt),
  ],
);

export type CyberTier = (typeof cyberTierEnum.enumValues)[number];
export type RepoTier = typeof repoTier.$inferSelect;
export type NewRepoTier = typeof repoTier.$inferInsert;
export type RepoTierChangeLog = typeof repoTierChangeLog.$inferSelect;
export type NewRepoTierChangeLog = typeof repoTierChangeLog.$inferInsert;

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type FindingStatus = typeof findingStatus.$inferSelect;
export type NewFindingStatus = typeof findingStatus.$inferInsert;
export type FindingValidationEvidenceBundle = typeof findingValidationEvidenceBundles.$inferSelect;
export type NewFindingValidationEvidenceBundle =
  typeof findingValidationEvidenceBundles.$inferInsert;
export type RepoThreatModel = typeof repoThreatModel.$inferSelect;
export type NewRepoThreatModel = typeof repoThreatModel.$inferInsert;
export type SarifImportBatch = typeof sarifImportBatch.$inferSelect;
export type NewSarifImportBatch = typeof sarifImportBatch.$inferInsert;
export type SarifIngestTokenUse = typeof sarifIngestTokenUse.$inferSelect;
export type NewSarifIngestTokenUse = typeof sarifIngestTokenUse.$inferInsert;
export type SarifFinding = typeof sarifFinding.$inferSelect;
export type NewSarifFinding = typeof sarifFinding.$inferInsert;
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
export type ReviewChallenge = typeof reviewChallenges.$inferSelect;
export type NewReviewChallenge = typeof reviewChallenges.$inferInsert;
export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type CronCursor = typeof cronCursors.$inferSelect;
export type NewCronCursor = typeof cronCursors.$inferInsert;
export type AgentClaim = typeof agentClaims.$inferSelect;
export type NewAgentClaim = typeof agentClaims.$inferInsert;
export type WeeklyFeature = typeof weeklyFeatures.$inferSelect;
export type NewWeeklyFeature = typeof weeklyFeatures.$inferInsert;
export type ReviewJob = typeof reviewJobs.$inferSelect;
export type NewReviewJob = typeof reviewJobs.$inferInsert;
export type X402ScanClaim = typeof x402ScanClaims.$inferSelect;
export type NewX402ScanClaim = typeof x402ScanClaims.$inferInsert;
export type X402ReviewClaim = typeof x402ReviewClaims.$inferSelect;
export type NewX402ReviewClaim = typeof x402ReviewClaims.$inferInsert;
export type ScorecardSnapshot = typeof scorecardSnapshots.$inferSelect;
export type NewScorecardSnapshot = typeof scorecardSnapshots.$inferInsert;
export type ReviewGateOutcome = typeof reviewGateOutcomes.$inferSelect;
export type NewReviewGateOutcome = typeof reviewGateOutcomes.$inferInsert;
export type FindingDisclosure = typeof findingDisclosure.$inferSelect;
export type NewFindingDisclosure = typeof findingDisclosure.$inferInsert;
export type FindingDisclosureLog = typeof findingDisclosureLog.$inferSelect;
export type NewFindingDisclosureLog = typeof findingDisclosureLog.$inferInsert;
