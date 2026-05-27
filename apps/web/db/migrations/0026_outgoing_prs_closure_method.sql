-- Absorbed-inline closure detection — adds closure metadata to outgoing_prs
-- so the sweep cron can classify closed-without-merge PRs as absorbed_inline
-- (fix landed via a separate upstream commit) vs declined (truly rejected).
-- Extends the receipt-eligible surface from merged-only to merged + absorbed.

ALTER TABLE outgoing_prs
  ADD COLUMN closure_method text,
  ADD COLUMN closure_sha text,
  ADD COLUMN closure_detected_at timestamptz,
  ADD COLUMN closure_confidence real,
  ADD COLUMN closure_notes text;

-- Backfill existing merged rows with closure_method = 'merged' and copy the
-- existing merge_sha into closure_sha so the data model is consistent from
-- day one. Existing 'closed' rows stay NULL until the backfill script or the
-- next sweep tick classifies them.
UPDATE outgoing_prs
  SET closure_method = 'merged',
      closure_sha = merge_sha,
      closure_detected_at = merged_at
  WHERE status = 'merged';
