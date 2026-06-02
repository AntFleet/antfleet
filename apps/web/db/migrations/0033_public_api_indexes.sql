-- Migration 0033: public v1 API lookup and pagination indexes

CREATE INDEX IF NOT EXISTS agent_findings_public_page_idx
  ON agent_findings (published_at DESC, finding_id ASC)
  WHERE agent_token_address NOT LIKE 'roast:%';

CREATE INDEX IF NOT EXISTS agent_findings_agent_page_idx
  ON agent_findings (lower(agent_token_address), published_at DESC, finding_id ASC)
  WHERE agent_token_address NOT LIKE 'roast:%';

CREATE INDEX IF NOT EXISTS agent_findings_repo_page_idx
  ON agent_findings (lower(repo_full_name), published_at DESC, finding_id ASC)
  WHERE agent_token_address NOT LIKE 'roast:%';

CREATE INDEX IF NOT EXISTS agent_findings_severity_page_idx
  ON agent_findings (severity, published_at DESC, finding_id ASC)
  WHERE agent_token_address NOT LIKE 'roast:%';

CREATE INDEX IF NOT EXISTS drift_snapshots_agent_commit_idx
  ON drift_snapshots (lower(agent_token_address), commit_timestamp DESC, id ASC);

CREATE INDEX IF NOT EXISTS drift_snapshots_agent_observed_idx
  ON drift_snapshots (lower(agent_token_address), observed_at DESC, id ASC);

CREATE INDEX IF NOT EXISTS factory_launches_published_token_idx
  ON factory_launches (prelaunch_status, lower(token_address));

CREATE INDEX IF NOT EXISTS factory_launches_directory_idx
  ON factory_launches (prelaunch_status, deployed_at DESC, token_address ASC);
