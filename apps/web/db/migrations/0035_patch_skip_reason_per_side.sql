-- 0035_patch_skip_reason_per_side
-- Patch Agent diagnostic surface — per-side orchestrator skip reason.
--
-- Background: when one provider ships a patch and the other doesn't, the
-- gate writes patch_skip_reason='models_disagreed', dropping the failing
-- side's specific reason (generation_error / size_cap / outside_diff_hunk
-- / clean null-decline). The diagnostic in
-- .omc/research/gpt5-patch-failure-diagnosis.md shows this lossiness
-- made silent GPT-5 errors indistinguishable from clean declines.
--
-- These columns carry each side's reason verbatim from
-- ProviderPatchProposal.skipReason. Both nullable, both observability-only.
-- Nulls are NORMAL: a provider that shipped a patch leaves its side null;
-- pre-migration rows stay null on both sides. The aggregate
-- patch_skip_reason column above is preserved unchanged for backward compat.

ALTER TABLE finding_status
  ADD COLUMN IF NOT EXISTS patch_skip_reason_opus text;

ALTER TABLE finding_status
  ADD COLUMN IF NOT EXISTS patch_skip_reason_gpt5 text;

-- Same value union as patch_skip_reason (migration 0020). The 'disabled'
-- and 'models_disagreed' members are kept in the union for caller
-- convenience even though the orchestrator never emits them on per-side
-- proposals — keeps the CHECK identical to patch_skip_reason so future
-- code paths can write either column with the same allowlist.
DO $$
BEGIN
  ALTER TABLE finding_status
    ADD CONSTRAINT finding_status_patch_skip_reason_opus_check
    CHECK (
      patch_skip_reason_opus IS NULL
      OR patch_skip_reason_opus IN (
        'models_disagreed', 'outside_diff_hunk', 'generation_error', 'disabled', 'size_cap'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE finding_status
    ADD CONSTRAINT finding_status_patch_skip_reason_gpt5_check
    CHECK (
      patch_skip_reason_gpt5 IS NULL
      OR patch_skip_reason_gpt5 IN (
        'models_disagreed', 'outside_diff_hunk', 'generation_error', 'disabled', 'size_cap'
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
