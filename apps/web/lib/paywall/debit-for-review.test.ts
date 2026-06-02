// Tests the shared debitForReview helper that both the webhook and the
// on-demand /api/v1/installations/{id}/review endpoint funnel through.
// The helper's contract:
//   1. Quantize price → call debitChannel (atomic CAS) → on null return,
//      return { ok: false, reason: "insufficient_at_debit" } — no ledger
//      insert.
//   2. On debit success → call recordDrawdown; ledger insert failures
//      are logged but DO NOT roll back the channel mutation. Return
//      { ok: true, debitedUsdc, newBalanceUsdc, drawdownId: id-or-null }.
//
// Mocks the Queryable interface so the test doesn't need a real Postgres.
// Production atomicity comes from Postgres row locking on debitChannel's
// UPDATE — see atomicity.test.ts for that invariant.

import { describe, expect, it, vi } from "vitest";
import type { db } from "@/db";
import { debitForJob, debitForReview, type DebitForReviewResult } from "./gate";
import type { GateDecision } from "./gate";

// debitForReview's Queryable type is Pick<typeof db, "execute">, where
// db.execute returns a drizzle PgRaw<NeonHttpQueryResult>. We don't
// instantiate that — the helper only reads the .rows shape — so we cast
// our minimal stub to the production type.
type DbQueryable = Pick<typeof db, "execute">;

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000099";
const REVIEW_ID = "00000000-0000-4000-8000-0000000000aa";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

type ExecCall = { sql: string; params: unknown[] };

function makeQueryable(opts: {
  // Sequenced responses for execute() calls. Each call shifts one off.
  responses: Array<unknown>;
}): {
  execute: (q: unknown) => Promise<unknown>;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const responses = [...opts.responses];
  const execute = vi.fn(async (q: unknown) => {
    const sqlObj = q as { strings?: string[]; queryChunks?: unknown[] };
    const sqlText = Array.isArray(sqlObj.strings) ? sqlObj.strings.join("?") : String(q);
    calls.push({ sql: sqlText, params: [] });
    if (responses.length === 0) {
      throw new Error("makeQueryable: unexpected execute() call beyond programmed responses");
    }
    return responses.shift();
  });
  return { execute, calls };
}

function debitDecision(priceUsdc: string): Extract<GateDecision, { kind: "debit" }> {
  return {
    kind: "debit",
    installationRowId: ROW_ID,
    channelId: CHANNEL_ID,
    balanceUsdc: "1.000000",
    priceUsdc,
    walletAddress: WALLET,
  };
}

describe("debitForReview", () => {
  it("returns ok with the new balance and drawdown id on the happy path", async () => {
    const q = makeQueryable({
      responses: [
        // debitChannel UPDATE ... RETURNING balance_usdc::text AS newBalanceUsdc
        { rows: [{ newBalanceUsdc: "0.500000" }] },
        // recordDrawdown INSERT INTO payments ... RETURNING id
        { rows: [{ id: "drawdown-id-1" }] },
      ],
    });
    const result: DebitForReviewResult = await debitForReview(q as unknown as DbQueryable, {
      decision: debitDecision("0.50"),
      reviewId: REVIEW_ID,
    });
    expect(result).toEqual({
      ok: true,
      debitedUsdc: "0.500000",
      newBalanceUsdc: "0.500000",
      drawdownId: "drawdown-id-1",
    });
    expect(q.calls).toHaveLength(2);
  });

  it("returns insufficient_at_debit and skips the ledger insert when balance < price", async () => {
    const q = makeQueryable({
      responses: [
        // debitChannel UPDATE returns no rows — WHERE balance_usdc >= price failed
        { rows: [] },
      ],
    });
    const result = await debitForReview(q as unknown as DbQueryable, {
      decision: debitDecision("0.50"),
      reviewId: REVIEW_ID,
    });
    expect(result).toEqual({ ok: false, reason: "insufficient_at_debit" });
    // No second call: the ledger insert is gated on debit success.
    expect(q.calls).toHaveLength(1);
  });

  it("returns ok with drawdownId=null when the ledger insert throws (debit still persists)", async () => {
    // Best-effort drawdown semantics: the debit already mutated the
    // channel balance; if the ledger row insert throws, we log loudly
    // but DO NOT roll back. This test pins that contract — the helper
    // must return ok: true so the caller proceeds with the review.
    const calls: ExecCall[] = [];
    let i = 0;
    const execute = vi.fn(async (q: unknown) => {
      calls.push({ sql: String(q), params: [] });
      if (i === 0) {
        i++;
        return { rows: [{ newBalanceUsdc: "0.500000" }] };
      }
      throw new Error("payments insert failed: connection terminated");
    });
    const result = await debitForReview({ execute } as unknown as DbQueryable, {
      decision: debitDecision("0.50"),
      reviewId: REVIEW_ID,
    });
    expect(result).toEqual({
      ok: true,
      debitedUsdc: "0.500000",
      newBalanceUsdc: "0.500000",
      drawdownId: null,
    });
    expect(calls).toHaveLength(2);
  });

  it("quantizes a one-decimal price to 6-decimal canonical form before the debit", async () => {
    // Operators write REVIEW_PRICE_USDC as "0.50"; payments.amount_usdc
    // is numeric(18,6). The helper must canonicalize so every row has
    // the same form regardless of input. The atomicity test pins how
    // debitChannel uses ::numeric internally; this test pins that the
    // string we pass to recordDrawdown matches the post-quantization
    // value (so audit queries that string-compare don't miss rows).
    const q = makeQueryable({
      responses: [
        { rows: [{ newBalanceUsdc: "0.500000" }] },
        { rows: [{ id: "drawdown-id-quant" }] },
      ],
    });
    const result = await debitForReview(q as unknown as DbQueryable, {
      decision: debitDecision("0.5"),
      reviewId: REVIEW_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.debitedUsdc).toBe("0.500000");
    }
  });
});

describe("debitForJob", () => {
  it("debits, records drawdown, links, and queues the job in one statement", async () => {
    const q = makeQueryable({
      responses: [
        {
          rows: [
            {
              jobReady: true,
              newBalanceUsdc: "0.500000",
              drawdownId: "drawdown-id-job",
              queued: true,
            },
          ],
        },
      ],
    });

    const result = await debitForJob(q as unknown as DbQueryable, {
      decision: debitDecision("0.50"),
      jobId: "job-1",
    });

    expect(result).toEqual({
      ok: true,
      debitedUsdc: "0.500000",
      newBalanceUsdc: "0.500000",
      drawdownId: "drawdown-id-job",
    });
    expect(q.calls).toHaveLength(1);
  });

  it("returns insufficient without queuing when the atomic debit cannot lock funds", async () => {
    const q = makeQueryable({
      responses: [
        {
          rows: [
            {
              jobReady: true,
              newBalanceUsdc: null,
              drawdownId: null,
              queued: false,
            },
          ],
        },
      ],
    });

    const result = await debitForJob(q as unknown as DbQueryable, {
      decision: debitDecision("0.50"),
      jobId: "job-1",
    });

    expect(result).toEqual({ ok: false, reason: "insufficient_at_debit" });
    expect(q.calls).toHaveLength(1);
  });

  it("throws before debit semantics when the billing-pending job is unavailable", async () => {
    const q = makeQueryable({
      responses: [
        {
          rows: [
            {
              jobReady: false,
              newBalanceUsdc: null,
              drawdownId: null,
              queued: false,
            },
          ],
        },
      ],
    });

    await expect(
      debitForJob(q as unknown as DbQueryable, {
        decision: debitDecision("0.50"),
        jobId: "job-1",
      }),
    ).rejects.toThrow("billing-pending review job was not available for debit");
  });
});
