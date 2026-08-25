-- 0056: agent_findings verification provenance — structured record of
-- whether a published finding survived verification, and how.
--
-- Motivation (2026-08-25 ratspeak bench): the unanimous gate flagged a
-- MEDIUM bug whose refutation depended on reading the callee's source in a
-- path-depended-on repo (rsReticulum). That refutation was published as
-- markdown prose only — indistinguishable from narrative to any consumer.
-- These columns give the verification pass a structured, queryable home so:
--   * 'verified'   — repro-exec verdict reached (or equivalent machine proof)
--   * 'refuted'    — finding did not survive verification (with notes why)
--   * 'inconclusive' — pipeline ran but could not decide (e.g. no cargo in
--                      the exec image; missing offline deps)
-- All nullable: legacy rows and clean reviews carry no verification pass.
ALTER TABLE agent_findings
  ADD COLUMN IF NOT EXISTS verification_status text,
  ADD COLUMN IF NOT EXISTS verification_method text,
  ADD COLUMN IF NOT EXISTS verification_notes text,
  ADD COLUMN IF NOT EXISTS verification_at timestamptz;
