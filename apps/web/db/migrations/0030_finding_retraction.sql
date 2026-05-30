-- 0030_finding_retraction
-- Retraction surface for published findings. When the unanimous gate produces
-- a false positive (both models share a hallucination about a safe pattern),
-- the operator can retract the finding: the /anatomy page stops emitting JSON-LD
-- and renders a retraction notice instead, and a noindex meta tag tells crawlers
-- to drop it. All columns nullable — a non-retracted finding (the overwhelming
-- majority) has retracted_at IS NULL and renders exactly as before.
ALTER TABLE finding_status
  ADD COLUMN IF NOT EXISTS retracted_at       timestamptz,
  ADD COLUMN IF NOT EXISTS retraction_reason  text,
  ADD COLUMN IF NOT EXISTS retraction_email   text;
