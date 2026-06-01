-- 0031_patch_rationales
-- Persist provider-side patch rationales so Patch Agent declines are
-- diagnosable after the run. Nullable preserves existing rows and keeps
-- public rendering unchanged.

ALTER TABLE finding_status
  ADD COLUMN IF NOT EXISTS patch_rationale_opus text,
  ADD COLUMN IF NOT EXISTS patch_rationale_gpt5 text;
