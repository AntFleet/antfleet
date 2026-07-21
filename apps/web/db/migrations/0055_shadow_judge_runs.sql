-- 0055: shadow_judge_runs + shadow_judge_labels — GLM 5.2 shadow-replay
-- dogfood harness (decision memo 2026-07-21).
--
-- The two_of_three corroborated tier (migration 0052) stays OFF in
-- production until a shadow dogfood proves the judge: replay stored
-- Opus/GPT-5 disagreement events through the SAME runAdjudication path,
-- 3-5 runs per event per variant, and gate promotion on
-- (a) corroborated precision >= unanimous precision vs held-out human
-- labels and (b) rerun stability. Nothing here touches the production
-- flag or finding_status.
CREATE TABLE IF NOT EXISTS shadow_judge_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL,
  -- sha256(review_id|provider|title|path) — stable per disagreement event.
  finding_key text NOT NULL,
  flagging_provider text NOT NULL,
  -- 'full' (prod-identical prompt) | 'blinded' (finding prose withheld;
  -- judge sees location + code excerpt only — contamination control).
  variant text NOT NULL,
  run_index integer NOT NULL,
  verdict text NOT NULL,
  corroborated boolean NOT NULL,
  reason text NOT NULL,
  judge_model text NOT NULL,
  harness_version text NOT NULL,
  -- Determinism pin: the exact candidate Finding judged, snapshotted.
  finding_snapshot jsonb NOT NULL,
  excerpt_present boolean NOT NULL,
  ms integer NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent resume: re-running the script never duplicates a
-- (event, variant, run) cell.
CREATE UNIQUE INDEX IF NOT EXISTS shadow_judge_runs_cell_uniq
  ON shadow_judge_runs (finding_key, variant, run_index);

CREATE INDEX IF NOT EXISTS shadow_judge_runs_review_idx
  ON shadow_judge_runs (review_id);

-- Held-out human ground truth, one label per disagreement event. Kept
-- separate from runs so labels are never duplicated per run and can be
-- assigned before or after judging (never self-graded in the moment).
CREATE TABLE IF NOT EXISTS shadow_judge_labels (
  finding_key text PRIMARY KEY,
  -- 'real' | 'not_real'
  label text NOT NULL,
  notes text,
  labeled_at timestamptz NOT NULL DEFAULT now()
);
