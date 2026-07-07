-- Migration 0049 — attribution columns on maintainer_reactions (Step 0.5, item 1).
--
-- Adds two nullable columns so the reaction pipeline can record WHO reacted:
--
--   reactor_login       — GitHub login of the user who placed the reaction.
--                         Populated from the reaction poll API (r.user.login).
--   author_association  — GitHub COLLABORATOR / MEMBER / OWNER etc.
--                         NOT available from the reaction poll endpoint;
--                         column is reserved for the dismiss-reply ingestion
--                         path (Step 0.5 item 4) that reads it from
--                         issue_comment.created webhook payload.
--
-- Both columns are nullable:
--   - reactor_login:      existing rows have no identity; new rows get it from
--                         the enriched mapper (reactions.ts).
--   - author_association: reaction poll API does NOT return association;
--                         only the webhook ingest path (Step 0.5 item 4)
--                         will populate this column.
--
-- Nothing reads these columns yet (dark / flag-off). Additive only.
-- Dedup uniqueness key (review_id, finding_id, reaction_at, action_taken)
-- is unchanged — the new columns are NOT part of the natural key.

ALTER TABLE maintainer_reactions ADD COLUMN reactor_login text;
ALTER TABLE maintainer_reactions ADD COLUMN author_association text;
