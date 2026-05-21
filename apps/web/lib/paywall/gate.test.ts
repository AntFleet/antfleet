import { describe, expect, it, vi } from "vitest";
import { decideGate, type GateDeps } from "./gate";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000099";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function deps(
  row: Parameters<GateDeps["loadInstallationGateRow"]>[0] extends never
    ? never
    : Awaited<ReturnType<GateDeps["loadInstallationGateRow"]>>,
  price = "0.50",
): GateDeps {
  return {
    loadInstallationGateRow: vi.fn(async () => row),
    getPriceUsdc: () => price,
  };
}

describe("decideGate", () => {
  it("returns not_installed when no row matches (installation_id, repo)", async () => {
    const result = await decideGate(
      { installationId: 1, repo: "foo" },
      deps(null),
    );
    expect(result.kind).toBe("not_installed");
  });

  it("returns bypass for a legacy_partner row regardless of channel", async () => {
    const result = await decideGate(
      { installationId: 1, repo: "foo" },
      deps({
        id: ROW_ID,
        status: "approved",
        legacyPartner: true,
        walletAddress: null,
        channelId: null,
        channelBalanceUsdc: null,
      }),
    );
    expect(result).toEqual({ kind: "bypass", installationRowId: ROW_ID });
  });

  it("returns not_installed for a paywall row that hasn't reached status=active", async () => {
    const result = await decideGate(
      { installationId: 1, repo: "foo" },
      deps({
        id: ROW_ID,
        status: "awaiting_deposit",
        legacyPartner: false,
        walletAddress: WALLET,
        channelId: null,
        channelBalanceUsdc: null,
      }),
    );
    expect(result.kind).toBe("not_installed");
  });

  it("returns insufficient when balance < price", async () => {
    const result = await decideGate(
      { installationId: 1, repo: "foo" },
      deps({
        id: ROW_ID,
        status: "active",
        legacyPartner: false,
        walletAddress: WALLET,
        channelId: CHANNEL_ID,
        channelBalanceUsdc: "0.250000",
      }),
    );
    expect(result.kind).toBe("insufficient");
    expect(result).toMatchObject({
      installationRowId: ROW_ID,
      channelId: CHANNEL_ID,
      balanceUsdc: "0.250000",
      priceUsdc: "0.50",
      walletAddress: WALLET,
    });
  });

  it("returns debit when balance >= price", async () => {
    const result = await decideGate(
      { installationId: 1, repo: "foo" },
      deps({
        id: ROW_ID,
        status: "active",
        legacyPartner: false,
        walletAddress: WALLET,
        channelId: CHANNEL_ID,
        channelBalanceUsdc: "0.500000",
      }),
    );
    expect(result.kind).toBe("debit");
    expect(result).toMatchObject({ channelId: CHANNEL_ID, priceUsdc: "0.50" });
  });

  it("returns debit when balance == price (boundary)", async () => {
    const result = await decideGate(
      { installationId: 1, repo: "foo" },
      deps(
        {
          id: ROW_ID,
          status: "active",
          legacyPartner: false,
          walletAddress: WALLET,
          channelId: CHANNEL_ID,
          channelBalanceUsdc: "5.000000",
        },
        "5.000000",
      ),
    );
    expect(result.kind).toBe("debit");
  });
});
