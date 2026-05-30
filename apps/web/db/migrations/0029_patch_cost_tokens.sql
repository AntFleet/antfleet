-- 0029_patch_cost_tokens
-- Patch Agent cost instrumentation. Per-finding token spend for the two
-- patch-proposal calls (Opus + GPT-5) that fire on every unanimous finding
-- once PATCH_AGENT_ENABLED is on. Nullable so flag-off / pre-instrumentation
-- rows stay byte-identical and the heuristic reconciliation cron can tell a
-- never-measured row (NULL) from a genuinely-zero one. The aggregate USD cost
-- continues to land on reviews.cost_patch_usd; these columns are the
-- per-finding split for eval-harness attribution.
ALTER TABLE finding_status
  ADD COLUMN IF NOT EXISTS input_tokens_opus   integer,
  ADD COLUMN IF NOT EXISTS output_tokens_opus  integer,
  ADD COLUMN IF NOT EXISTS input_tokens_gpt5   integer,
  ADD COLUMN IF NOT EXISTS output_tokens_gpt5  integer;
