-- AI Scorecard — immutable weekly snapshots of provider-comparison stats.
-- Snapshots are computed at scorecard-cron time and persisted as JSONB
-- payloads. Historical numbers never drift even as underlying reviews
-- evolve (opt-in flips, backfills, retroactive corrections).

CREATE TABLE scorecard_snapshots (
  yyyy_mm_dd text PRIMARY KEY,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generator_version text NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX scorecard_snapshots_generated_at_idx ON scorecard_snapshots (generated_at DESC);
