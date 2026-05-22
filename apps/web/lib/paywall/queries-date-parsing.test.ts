// Regression tests for the Neon-serverless timestamp-string bug.
//
// The Neon serverless driver returns `timestamp with time zone` columns as
// ISO-8601 strings, NOT Date objects. Our row types declared these as `Date`
// for years; bind/get/etc. then crashed in prod when they ran `.getTime()`
// or `.toISOString()` on the string. (See discovery in chat log when first
// real install hit POST /v1/installations/{id}/bind → 500 "o.getTime is not
// a function".)
//
// These tests pin: every loader that returns a row with declared Date
// fields normalizes the runtime value to a real Date instance before the
// row escapes the function. Future loaders should be added here when added
// to queries.ts.

import { describe, expect, it } from "vitest";
import {
  insertPaywallInstallation,
  insertReviewChallenge,
  loadChannelForInstallation,
  loadPaywallInstallation,
  loadReviewChallenge,
  loadWalletReputation,
} from "./queries";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000002";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000003";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const CREATED_AT_ISO = "2026-05-22T07:13:44.383Z";
const BOUND_AT_ISO = "2026-05-22T07:14:00.000Z";
const DRAWDOWN_AT_ISO = "2026-05-22T07:15:00.000Z";
const ISSUED_AT_ISO = "2026-05-22T07:16:00.000Z";
const EXPIRES_AT_ISO = "2026-05-22T07:26:00.000Z";
const USED_AT_ISO = "2026-05-22T07:17:00.000Z";

// Helper: build a stub Queryable that returns canned rows per execute() call.
function dbFromRows(rows: unknown[]): { execute: (q: unknown) => Promise<unknown> } {
  let i = 0;
  return {
    execute: async () => {
      if (i >= rows.length) {
        throw new Error(`unexpected execute() call beyond ${rows.length} stubbed`);
      }
      const r = rows[i];
      i += 1;
      return r;
    },
  };
}

describe("Neon timestamp-string normalization", () => {
  it("loadPaywallInstallation: createdAt + walletBoundAt are real Date instances", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: ROW_ID,
            status: "awaiting_deposit",
            walletAddress: WALLET,
            walletProofSignature: `0x${"a".repeat(130)}`,
            // ↓ Neon returns ISO strings here; loader must parse to Date.
            walletBoundAt: BOUND_AT_ISO,
            legacyPartner: false,
            installationId: null,
            owner: null,
            repo: null,
            createdAt: CREATED_AT_ISO,
          },
        ],
      },
    ]);
    const row = await loadPaywallInstallation(db as never, ROW_ID);
    expect(row).not.toBeNull();
    // The original prod crash was `row.createdAt.getTime() is not a function`.
    // Pin that .getTime() works post-loader without throwing.
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.createdAt.getTime()).toBe(new Date(CREATED_AT_ISO).getTime());
    expect(row?.walletBoundAt).toBeInstanceOf(Date);
    const wb = row?.walletBoundAt;
    if (wb !== null && wb !== undefined) {
      expect(wb.toISOString()).toBe(BOUND_AT_ISO);
    }
  });

  it("loadPaywallInstallation: walletBoundAt=null stays null (no spurious Date)", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: ROW_ID,
            status: "pending_binding",
            walletAddress: WALLET,
            walletProofSignature: null,
            walletBoundAt: null,
            legacyPartner: false,
            installationId: null,
            owner: null,
            repo: null,
            createdAt: CREATED_AT_ISO,
          },
        ],
      },
    ]);
    const row = await loadPaywallInstallation(db as never, ROW_ID);
    expect(row?.walletBoundAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("loadPaywallInstallation: returns null when no row matches", async () => {
    const db = dbFromRows([{ rows: [] }]);
    const row = await loadPaywallInstallation(db as never, ROW_ID);
    expect(row).toBeNull();
  });

  it("insertPaywallInstallation: returned row has Date fields", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: ROW_ID,
            status: "pending_binding",
            walletAddress: WALLET,
            walletProofSignature: null,
            walletBoundAt: null,
            legacyPartner: false,
            installationId: null,
            owner: null,
            repo: null,
            createdAt: CREATED_AT_ISO,
          },
        ],
      },
    ]);
    const row = await insertPaywallInstallation(db as never, { walletAddress: WALLET });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.createdAt.getTime()).toBe(new Date(CREATED_AT_ISO).getTime());
  });

  it("loadChannelForInstallation: createdAt + lastDrawdownAt are Date instances", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: CHANNEL_ID,
            installationId: ROW_ID,
            walletAddress: WALLET,
            balanceUsdc: "5.000000",
            createdAt: CREATED_AT_ISO,
            lastDepositTxHash: "0xdead",
            lastDrawdownAt: DRAWDOWN_AT_ISO,
          },
        ],
      },
    ]);
    const row = await loadChannelForInstallation(db as never, ROW_ID);
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.lastDrawdownAt).toBeInstanceOf(Date);
    const ldd = row?.lastDrawdownAt;
    if (ldd !== null && ldd !== undefined) {
      expect(ldd.toISOString()).toBe(DRAWDOWN_AT_ISO);
    }
  });

  it("loadChannelForInstallation: lastDrawdownAt=null stays null", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: CHANNEL_ID,
            installationId: ROW_ID,
            walletAddress: WALLET,
            balanceUsdc: "0",
            createdAt: CREATED_AT_ISO,
            lastDepositTxHash: null,
            lastDrawdownAt: null,
          },
        ],
      },
    ]);
    const row = await loadChannelForInstallation(db as never, ROW_ID);
    expect(row?.lastDrawdownAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("loadReviewChallenge: issuedAt + expiresAt + usedAt are Date instances", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: CHALLENGE_ID,
            installationRowId: ROW_ID,
            issuedAt: ISSUED_AT_ISO,
            expiresAt: EXPIRES_AT_ISO,
            usedAt: USED_AT_ISO,
            usedForReviewId: null,
          },
        ],
      },
    ]);
    const row = await loadReviewChallenge(db as never, CHALLENGE_ID);
    expect(row?.issuedAt).toBeInstanceOf(Date);
    expect(row?.expiresAt).toBeInstanceOf(Date);
    expect(row?.usedAt).toBeInstanceOf(Date);
    // Pin .getTime() works — the on-demand review route uses it to compute
    // TTL skew. Was the second instance of the same bug.
    expect(row?.issuedAt.getTime()).toBe(new Date(ISSUED_AT_ISO).getTime());
  });

  it("loadReviewChallenge: usedAt=null stays null", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: CHALLENGE_ID,
            installationRowId: ROW_ID,
            issuedAt: ISSUED_AT_ISO,
            expiresAt: EXPIRES_AT_ISO,
            usedAt: null,
            usedForReviewId: null,
          },
        ],
      },
    ]);
    const row = await loadReviewChallenge(db as never, CHALLENGE_ID);
    expect(row?.usedAt).toBeNull();
    expect(row?.issuedAt).toBeInstanceOf(Date);
  });

  it("insertReviewChallenge: returned row has Date fields", async () => {
    const db = dbFromRows([
      {
        rows: [
          {
            id: CHALLENGE_ID,
            installationRowId: ROW_ID,
            issuedAt: ISSUED_AT_ISO,
            expiresAt: EXPIRES_AT_ISO,
            usedAt: null,
            usedForReviewId: null,
          },
        ],
      },
    ]);
    const row = await insertReviewChallenge(db as never, {
      installationRowId: ROW_ID,
      issuedAt: new Date(ISSUED_AT_ISO),
      expiresAt: new Date(EXPIRES_AT_ISO),
    });
    expect(row.issuedAt).toBeInstanceOf(Date);
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it("loadWalletReputation: per-install boundAt is a Date instance", async () => {
    // Sequence matches loadWalletReputation's query order: installs, reviews,
    // findings, settled, balance.
    const db = dbFromRows([
      // installations + channels join
      {
        rows: [
          {
            installationRowId: ROW_ID,
            githubInstallationId: 12345,
            owner: "acme",
            repo: "demo",
            status: "active",
            boundAt: BOUND_AT_ISO,
            channelBalanceUsdc: "5.000000",
          },
        ],
      },
      // reviews count
      { rows: [{ value: 0 }] },
      // findings stats
      { rows: [{ total: 0, closed: 0, patchesProposed: 0, patchesAccepted: 0 }] },
      // total settled
      { rows: [{ value: "0" }] },
      // current balance
      { rows: [{ value: "5" }] },
    ]);
    const rep = await loadWalletReputation(db as never, WALLET);
    expect(rep).not.toBeNull();
    expect(rep?.installations[0]?.boundAt).toBeInstanceOf(Date);
    const ba = rep?.installations[0]?.boundAt;
    if (ba !== null && ba !== undefined) {
      expect(ba.toISOString()).toBe(BOUND_AT_ISO);
    }
  });
});
