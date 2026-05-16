import {
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Schema follows AGENTS.md §10 verbatim. Changes here are schema_version bumps
// — the column is preserved so historical rows remain interpretable.

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
});

export const maintainerReactions = pgTable("maintainer_reactions", {
  reactionId: uuid("reaction_id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id")
    .notNull()
    .references(() => reviews.reviewId, { onDelete: "cascade" }),
  findingId: text("finding_id").notNull(),
  actionTaken: text("action_taken").notNull(),
  reactionAt: timestamp("reaction_at", { withTimezone: true }).notNull(),
  maintainerComment: text("maintainer_comment"),
  polledAt: timestamp("polled_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type MaintainerReaction = typeof maintainerReactions.$inferSelect;
export type NewMaintainerReaction = typeof maintainerReactions.$inferInsert;
