import {
  bigint,
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

export const reviews = pgTable("reviews", {
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
});

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
    unique("maintainer_reactions_dedup").on(
      t.reviewId,
      t.findingId,
      t.reactionAt,
      t.actionTaken,
    ),
  ],
);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type FindingStatus = typeof findingStatus.$inferSelect;
export type NewFindingStatus = typeof findingStatus.$inferInsert;
export type MaintainerReaction = typeof maintainerReactions.$inferSelect;
export type NewMaintainerReaction = typeof maintainerReactions.$inferInsert;
