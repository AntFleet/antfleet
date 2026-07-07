// Win 2 — reader-guard regression test for loadRelatedFindings.
//
// The /disagreements/[id] page shows findings from the same review that
// "passed the unanimous gate". A shadow finding_status row
// (source='single_model') shares the same reviewId and would render here
// mislabeled as "passed the unanimous gate" if the source='consensus' guard
// were absent from the WHERE clause.
//
// This test builds the actual drizzle query that loadRelatedFindings issues
// (via a pg-proxy callback that captures the rendered SQL + params) and
// asserts the consensus guard is present in BOTH the disclosure-gate-on and
// disclosure-gate-off branches.  It fails if the guard is removed.
//
// Pattern mirrors apps/web/db/queries.receipt-shadow-guard.test.ts but uses
// the pg-proxy drizzle driver instead of db.execute, because loadRelatedFindings
// uses the drizzle query builder (db.select().from()…) rather than raw SQL.
// The query builder renders param values as bound $N placeholders; we assert:
//   1) the WHERE clause contains a `finding_status`.`source` comparison, AND
//   2) the params array includes the string "consensus".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captured query from the pg-proxy callback — hoisted so vi.mock factory
// can close over it.
const capturedQuery = vi.hoisted(() => ({
  last: null as { sql: string; params: unknown[] } | null,
}));

// Mock @/db/index with a pg-proxy drizzle instance that intercepts execution
// and captures the SQL + params instead of hitting a real database.
vi.mock("@/db/index", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const schema = await import("@/db/schema");
  const db = drizzle(
    async (sql, params) => {
      capturedQuery.last = { sql, params };
      return { rows: [] };
    },
    { schema },
  );
  return { db };
});

vi.mock("@/lib/daybreak-gates-env", () => ({
  isDisclosureGateEnabled: vi.fn(),
  isCyberTierEnabled: vi.fn(),
}));

// Mock cyber-tier so the gate is off (returns `true` fragment) — prevents
// a second db import chain from firing and keeps the WHERE focused.
vi.mock("@/lib/cyber-tier", async () => {
  const { sql } = await import("drizzle-orm");
  return {
    nonCyberTierRepoCondition: () => sql<boolean>`true`,
  };
});

// loadDisagreementDetail is imported at module level but only called from
// the page default export, not from loadRelatedFindings.  Stub it to avoid
// the real queries path.
vi.mock("@/lib/disagreements", () => ({
  loadDisagreementDetail: vi.fn(),
  redactSecrets: (s: string) => s,
}));

import { isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";
import { loadRelatedFindings } from "@/app/disagreements/[id]/page";

const REVIEW_ID = "bbbb2222-0000-0000-0000-000000000099";

beforeEach(() => {
  capturedQuery.last = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadRelatedFindings shadow-tier reader guard", () => {
  it("includes source='consensus' in WHERE params (non-disclosure branch)", async () => {
    vi.mocked(isDisclosureGateEnabled).mockReturnValue(false);
    await loadRelatedFindings(REVIEW_ID);

    expect(capturedQuery.last, "loadRelatedFindings did not call db").not.toBeNull();
    const { sql, params } = capturedQuery.last!;

    // The WHERE clause must reference the source column.
    expect(sql).toMatch(/source/);
    // The bound params must include the 'consensus' guard value.
    expect(params).toContain("consensus");
  });

  it("includes source='consensus' in WHERE params (disclosure gate enabled branch)", async () => {
    vi.mocked(isDisclosureGateEnabled).mockReturnValue(true);
    await loadRelatedFindings(REVIEW_ID);

    expect(capturedQuery.last, "loadRelatedFindings did not call db").not.toBeNull();
    const { sql, params } = capturedQuery.last!;

    // The WHERE clause must reference the source column.
    expect(sql).toMatch(/source/);
    // The bound params must include the 'consensus' guard value.
    expect(params).toContain("consensus");
  });

  it("does NOT surface shadow rows (params must NOT include 'single_model')", async () => {
    vi.mocked(isDisclosureGateEnabled).mockReturnValue(false);
    await loadRelatedFindings(REVIEW_ID);

    const { params } = capturedQuery.last!;
    // The query must never bind 'single_model' — that would select shadow rows.
    expect(params).not.toContain("single_model");
  });
});
