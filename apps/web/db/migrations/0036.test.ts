import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migration0036Statements } from "./apply-migration-0036";

const sqlText = readFileSync(join(__dirname, "0036_review_jobs_acp.sql"), "utf8");

describe("migration 0036 static shape", () => {
  it("adds ACP as a first-class review_jobs rail with submit tracking", () => {
    const statements = migration0036Statements(sqlText);
    const joined = statements.join("\n");

    expect(joined).toContain("CHECK (payment_rail IN ('channel','x402','acp'))");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS acp_job_id text");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS acp_target_key text");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS acp_request_payload jsonb");
    expect(joined).toContain("ADD COLUMN IF NOT EXISTS acp_budget_status text");
    expect(joined).toContain("review_jobs_acp_submit_status_check");
    expect(joined).toContain("review_jobs_acp_budget_status_check");
    expect(joined).toContain("review_jobs_acp_wallet_check");
    expect(joined).toContain("'processing'");
    expect(joined).toContain("'dead_lettered'");
    expect(joined).toContain("'submitting'");
    expect(joined).toContain("'set_reconcile'");
    expect(joined).toContain("idx_review_jobs_acp_job_id_unique");
    expect(joined).toContain("idx_review_jobs_acp_target_key_unique");
    expect(joined).toContain("CREATE TABLE IF NOT EXISTS acp_provider_events");
    expect(joined).toContain("idx_acp_provider_events_event_key_unique");
  });
});
