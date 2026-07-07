// Win 2 — reader-guard regression test for loadPublicReviewReceipt.
//
// A shadow finding_status row (source='single_model', `-s{index}` id) must
// NEVER surface in the public review receipt's `findings[]`. The public
// receipt aggregates finding_status via a `jsonb_agg(...) FILTER (...)`; if the
// FILTER omits the `source = 'consensus'` guard, a shadow row leaks into the
// public payload and — because it indexes into singleModelTier[] rather than
// agreement_decision.agreed[] — corrupts the receipt AND breaks the
// "private until brand decision" contract on the public_receipt=true canary.
//
// This test renders the SQL that loadPublicReviewReceipt actually issues (both
// the disclosure-gate branch and the non-disclosure branch, since the canary is
// public_receipt=true) and asserts the consensus guard is present in the
// finding-aggregation FILTER. It fails if either branch drops the guard.
//
// Pattern: mock ./index so db.execute captures the drizzle SQL object without a
// live DB; render it with PgDialect; mock the gate env to toggle both branches.

import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedSql = vi.hoisted(() => ({ last: null as unknown }));

vi.mock("./index", () => ({
  db: {
    execute: vi.fn((stmt: unknown) => {
      capturedSql.last = stmt;
      // Shape mirrors neon-serverless: { rows: [...] }. Empty is fine — the
      // test only inspects the SQL the loader emitted, not the result.
      return Promise.resolve({ rows: [] });
    }),
  },
}));

vi.mock("@/lib/daybreak-gates-env", () => ({
  isDisclosureGateEnabled: vi.fn(),
  isCyberTierEnabled: vi.fn(),
}));

import { loadPublicReviewReceipt } from "./queries";
import { isCyberTierEnabled, isDisclosureGateEnabled } from "@/lib/daybreak-gates-env";

const REVIEW_ID = "aaaa1111-0000-0000-0000-000000000042";
const dialect = new PgDialect();

function renderLastSql(): string {
  const stmt = capturedSql.last;
  expect(stmt, "loadPublicReviewReceipt did not call db.execute").not.toBeNull();
  // sqlToQuery renders params as $1, $2… — we only assert on structural SQL.
  return dialect.sqlToQuery(stmt as never).sql;
}

// Extract the jsonb_agg(...) FILTER (...) block that builds the public
// `findings[]` array, so the assertion targets the aggregation guard exactly
// (and not some unrelated `source` mention elsewhere in the statement).
function findingsAggFilter(rendered: string): string {
  const start = rendered.indexOf("jsonb_agg");
  expect(start, "rendered SQL has no jsonb_agg findings aggregation").toBeGreaterThan(-1);
  const filterIdx = rendered.indexOf("FILTER", start);
  expect(filterIdx, "findings jsonb_agg has no FILTER clause").toBeGreaterThan(-1);
  // The FILTER predicate ends before the closing `), '[]'::jsonb` COALESCE tail.
  const tail = rendered.indexOf("'[]'::jsonb", filterIdx);
  return rendered.slice(filterIdx, tail === -1 ? undefined : tail);
}

beforeEach(() => {
  capturedSql.last = null;
  vi.mocked(isCyberTierEnabled).mockReturnValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadPublicReviewReceipt shadow-tier reader guard", () => {
  it("guards the findings FILTER with source='consensus' (non-disclosure branch)", async () => {
    vi.mocked(isDisclosureGateEnabled).mockReturnValue(false);
    await loadPublicReviewReceipt(REVIEW_ID);
    const filter = findingsAggFilter(renderLastSql());
    expect(filter).toMatch(/fs\.source\s*=\s*'consensus'/);
  });

  it("guards the findings FILTER with source='consensus' (disclosure=state'none' / public_receipt=true canary path)", async () => {
    vi.mocked(isDisclosureGateEnabled).mockReturnValue(true);
    await loadPublicReviewReceipt(REVIEW_ID);
    const rendered = renderLastSql();
    // The finding-aggregation FILTER must carry the consensus guard…
    const filter = findingsAggFilter(rendered);
    expect(filter).toMatch(/fs\.source\s*=\s*'consensus'/);
    // …and it must sit alongside the disclosure branch that keeps state='none'
    // public_receipt=true findings visible — i.e. the guard did not accidentally
    // replace the canary-visibility predicate.
    expect(filter).toMatch(/state\s*=\s*'none'/);
  });

  it("scopes the receipt-suppression NOT EXISTS to consensus (disclosure branch)", async () => {
    // A shadow row must not be able to suppress the WHOLE public receipt via the
    // "all findings must be disclosed" NOT EXISTS guard on review_fs.
    vi.mocked(isDisclosureGateEnabled).mockReturnValue(true);
    await loadPublicReviewReceipt(REVIEW_ID);
    const rendered = renderLastSql();
    expect(rendered).toMatch(/review_fs\.source\s*=\s*'consensus'/);
  });
});
