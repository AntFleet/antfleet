import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("migration 0028", () => {
  const sql = readFileSync(join(__dirname, "0028_review_jobs_x402.sql"), "utf8");

  it("adds x402 review_jobs columns and indexes without failure_mode check", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS caller_wallet text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS payment_rail text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS x402_pay_to text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS x402_payment_payload jsonb");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS x402_valid_after timestamptz");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS x402_valid_before timestamptz");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS x402_review_id text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS x402_settlement_status text");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS x402_settlement_response jsonb");
    expect(sql).toContain("idx_review_jobs_caller_wallet");
    expect(sql).toContain("idx_review_jobs_payment_rail_created");
    expect(sql).toContain("idx_review_jobs_rail_installation_idempotency_unique");
    expect(sql).toContain("idx_review_jobs_x402_pay_to");
    expect(sql).toContain("idx_review_jobs_x402_review_id");
    expect(sql).toContain("idx_review_jobs_x402_settlement_status");
    expect(sql).not.toContain("review_jobs_failure_mode_check");
  });
});
