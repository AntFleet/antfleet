-- Migration 0048 — repo cyber tier (Daybreak follow-up to PR #101/#103/#105).
--
-- Adds a repo-scoped tier classification for sensitive repos. Two values:
--
--   default — every existing repo. Behavior unchanged from pre-cyber-tier.
--   cyber   — stricter posture for verified defenders / sensitive systems.
--             Every finding embargoes, public surfaces hide existence,
--             SARIF export 404s, threat-model public view hides,
--             evidence-bundle public sections redact PoC + repro + trace.
--
-- Side table (not a column on `installations` or a new `repo` table). Two
-- reasons:
--   1. `installations` is install-scoped (one row per install per repo).
--      Cyber tier is repo-scoped; the same upstream repo can have multiple
--      installs across different orgs and they must share the tier.
--   2. There is no `repo` table today, and creating one just for this
--      single enum would require backfilling from installations + reviews
--      + agent_findings. A narrow keyed side table is cheaper.
--
-- Key is lowercased (owner, repo). Reads always lowercase before lookup —
-- mirrors the pattern at repo_threat_model_owner_repo_idx and
-- publicAccessForThreatModel in repo-threat-model.ts.
--
-- repo_tier rows are operator-set only. The mutation API path lives at
-- /api/admin/repo/[owner]/[repo]/tier behind OPERATOR_SECRET bearer auth
-- (matches the pattern at /api/admin/disclosure/.../route.ts and
-- /api/admin/retract/route.ts). No webhook, install flow, or self-service
-- UI is allowed to call the setter — defense in depth via TypeScript-only
-- single-module export of the setter (lib/cyber-tier-admin.ts).
--
-- repo_tier_change_log is the audit trail. Every setter call writes one
-- row; the table is append-only. Reason is required and bounded to keep
-- short empty strings out and unbounded blobs out.

CREATE TYPE cyber_tier AS ENUM ('default', 'cyber');

CREATE TABLE IF NOT EXISTS repo_tier (
  owner_lc text NOT NULL,
  repo_lc  text NOT NULL,
  tier     cyber_tier NOT NULL DEFAULT 'default',
  set_by   text NOT NULL,
  set_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_lc, repo_lc)
);

CREATE INDEX IF NOT EXISTS repo_tier_tier_idx ON repo_tier (tier);

CREATE TABLE IF NOT EXISTS repo_tier_change_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_lc    text NOT NULL,
  repo_lc     text NOT NULL,
  old_tier    cyber_tier NOT NULL,
  new_tier    cyber_tier NOT NULL,
  reason      text NOT NULL,
  actor       text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT repo_tier_change_log_reason_length_check
    CHECK (char_length(reason) BETWEEN 10 AND 2000)
);

CREATE INDEX IF NOT EXISTS repo_tier_change_log_repo_idx
  ON repo_tier_change_log (owner_lc, repo_lc, changed_at DESC);

-- Global latest-change-timestamp lookup. Used by the scorecard
-- staleness check (db/queries.ts:latestCyberTierChangeAt) on every
-- public /scorecard read when ANTFLEET_CYBER_TIER is on. Without this
-- index the read would scan/sort the full audit log per request.
-- (Architect audit pass-10, severity medium, operational-indexing.)
CREATE INDEX IF NOT EXISTS repo_tier_change_log_changed_at_idx
  ON repo_tier_change_log (changed_at DESC);

COMMENT ON TABLE repo_tier IS
  'Per-repo cyber tier classification. One row per repo (lowercased owner+repo). Operator-set only via lib/cyber-tier-admin.ts.';
COMMENT ON TABLE repo_tier_change_log IS
  'Append-only audit log of repo_tier changes. Reason field constrained 10-2000 chars to force a real explanation.';
