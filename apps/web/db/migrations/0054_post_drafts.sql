-- 0054: post_drafts — durable DB sink for operator post drafts.
--
-- lib/post-drafts.ts generates event-driven drafts (roast published,
-- factory launch phases, receipt of the week, identity drift, outgoing
-- PR transitions) but its only sink was a filesystem write gated on
-- ANTFLEET_DRAFTS_DIR — unset on Vercel's read-only filesystem, so every
-- production draft short-circuited to a log line and was lost. This table
-- catches them instead; the operator drains it via scripts/post-queue.ts
-- or GET/POST /api/admin/post-drafts. Nothing auto-posts: status flips to
-- 'posted' only after the operator has tweeted via an intent link.
CREATE TABLE IF NOT EXISTS post_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  -- 'roast' | 'factory' | 'weekly' | 'outgoing_pr' | 'manual'
  source text NOT NULL DEFAULT 'manual',
  -- 'draft' | 'posted' | 'dismissed'
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- An event re-firing while its draft is still pending must not spam the
-- queue: at most one *pending* draft per slug. Posted/dismissed history
-- keeps every row.
CREATE UNIQUE INDEX IF NOT EXISTS post_drafts_pending_slug_uniq
  ON post_drafts (slug)
  WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS post_drafts_status_created_idx
  ON post_drafts (status, created_at DESC);
