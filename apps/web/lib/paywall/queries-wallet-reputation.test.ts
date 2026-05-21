import { describe, expect, it } from "vitest";
import { loadWalletReputation } from "./queries";

// Stub db.execute by call-order. loadWalletReputation issues queries in a
// fixed sequence (installations → reviews → findings → settled → balance);
// the test supplies a canned response for each successive call. A change
// to the query order surfaces here as an unexpected response.
function dbFromQueue(responses: unknown[]): { execute: (q: unknown) => Promise<unknown> } {
  let i = 0;
  return {
    execute: async () => {
      if (i >= responses.length) {
        throw new Error(`db.execute called ${i + 1} times; only ${responses.length} stubbed`);
      }
      const r = responses[i];
      i += 1;
      return r;
    },
  };
}

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("loadWalletReputation", () => {
  it("returns null when no installations are bound to the wallet", async () => {
    const db = dbFromQueue([[]]);
    const result = await loadWalletReputation(db as never, WALLET);
    expect(result).toBeNull();
  });

  it("aggregates reviews, findings, settled, and balance across installations", async () => {
    const db = dbFromQueue([
      // 1. installations join channels
      [
        {
          installationRowId: "r1",
          githubInstallationId: 100,
          owner: "alice",
          repo: "repo-a",
          status: "active",
          boundAt: new Date("2026-05-01T00:00:00Z"),
          channelBalanceUsdc: "3.000000",
        },
        {
          installationRowId: "r2",
          githubInstallationId: 101,
          owner: "alice",
          repo: "repo-b",
          status: "active",
          boundAt: new Date("2026-05-02T00:00:00Z"),
          channelBalanceUsdc: "1.500000",
        },
      ],
      // 2. reviews count
      [{ value: 7 }],
      // 3. finding stats
      [{ total: 12, closed: 9 }],
      // 4. drawdown sum
      [{ value: "3.500000" }],
      // 5. channel balance sum
      [{ value: "4.500000" }],
    ]);

    const result = await loadWalletReputation(db as never, WALLET);
    expect(result).not.toBeNull();
    expect(result?.totalReviews).toBe(7);
    expect(result?.findingsTotal).toBe(12);
    expect(result?.findingsClosed).toBe(9);
    expect(result?.totalSettledUsdc).toBe("3.500000");
    expect(result?.currentBalanceUsdc).toBe("4.500000");
    expect(result?.installations).toHaveLength(2);
    expect(result?.walletAddress).toBe(WALLET);
  });

  it("skips the reviews/findings queries when no github_installation_id is known", async () => {
    // An agent that bound a wallet + funded a channel but hasn't installed
    // the GitHub App yet has installation_id=NULL — there can be no
    // reviews / findings to count, so the function should issue 3 queries
    // (installations + settled + balance), not 5.
    const db = dbFromQueue([
      [
        {
          installationRowId: "r1",
          githubInstallationId: null,
          owner: null,
          repo: null,
          status: "active",
          boundAt: new Date("2026-05-01T00:00:00Z"),
          channelBalanceUsdc: "5.000000",
        },
      ],
      // settled
      [{ value: "0" }],
      // balance
      [{ value: "5.000000" }],
    ]);
    const result = await loadWalletReputation(db as never, WALLET);
    expect(result?.totalReviews).toBe(0);
    expect(result?.findingsTotal).toBe(0);
    expect(result?.totalSettledUsdc).toBe("0");
    expect(result?.currentBalanceUsdc).toBe("5.000000");
  });
});
