import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleDepositInstallation, type DepositInstallationDeps } from "./route";
import type { PaywallChannelRow, PaywallInstallationRow } from "@/lib/paywall/queries";
import { USDC_BASE_ADDRESS } from "@/lib/paywall/env";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000099";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const DEPOSIT_ADDR = "0x9999999999999999999999999999999999999999";
const TX_HASH = `0x${"b".repeat(64)}`;
const SIG = `0x${"a".repeat(130)}`;

function row(overrides: Partial<PaywallInstallationRow> = {}): PaywallInstallationRow {
  return {
    id: ROW_ID,
    status: "awaiting_deposit",
    walletAddress: WALLET,
    walletProofSignature: SIG,
    walletBoundAt: new Date(),
    legacyPartner: false,
    installationId: null,
    owner: null,
    repo: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function channel(overrides: Partial<PaywallChannelRow> = {}): PaywallChannelRow {
  return {
    id: CHANNEL_ID,
    installationId: ROW_ID,
    walletAddress: WALLET,
    balanceUsdc: "0.000000",
    createdAt: new Date(),
    lastDepositTxHash: null,
    lastDrawdownAt: null,
    ...overrides,
  };
}

// Build a fake viem receipt with one USDC Transfer log to depositAddress.
function buildTransferLog(args: { from: string; to: string; valueRaw: bigint }) {
  // Encoded uint256 (32 bytes) for the value
  const valueHex = args.valueRaw.toString(16).padStart(64, "0");
  return {
    address: USDC_BASE_ADDRESS as `0x${string}`,
    topics: [
      // keccak256("Transfer(address,address,uint256)")
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x000000000000000000000000${args.from.slice(2)}` as `0x${string}`,
      `0x000000000000000000000000${args.to.slice(2)}` as `0x${string}`,
    ] as readonly `0x${string}`[],
    data: `0x${valueHex}` as `0x${string}`,
  };
}

function deps(
  overrides: Partial<DepositInstallationDeps> = {},
  loadedRow: PaywallInstallationRow | null = row(),
  existingChannel: PaywallChannelRow | null = null,
): DepositInstallationDeps {
  let channelState = existingChannel;
  return {
    loadInstallation: vi.fn(async () => loadedRow),
    loadChannel: vi.fn(async () => channelState),
    createChannel: vi.fn(async () => {
      channelState = channel();
      return CHANNEL_ID;
    }),
    creditDeposit: vi.fn(async () => true),
    markActive: vi.fn(async () => undefined),
    verifier: {
      getTransactionReceipt: vi.fn(async () => ({
        status: "success" as const,
        from: WALLET as `0x${string}`,
        to: USDC_BASE_ADDRESS as `0x${string}`,
        blockNumber: 1_000_000n,
        logs: [buildTransferLog({ from: WALLET, to: DEPOSIT_ADDR, valueRaw: 5_000_000n })],
      })),
      getBlockNumber: vi.fn(async () => 1_000_010n),
    },
    getDepositAddress: () => DEPOSIT_ADDR,
    getMinDeposit: () => "5.00",
    ...overrides,
  };
}

function req(body: unknown): NextRequest {
  return new NextRequest(`http://test.local/api/v1/installations/${ROW_ID}/deposit`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: ROW_ID }) };

describe("POST /api/v1/installations/{id}/deposit", () => {
  it("credits a verified deposit and transitions to active", async () => {
    const creditDeposit = vi.fn(async () => true);
    const markActive = vi.fn(async () => undefined);
    const res = await handleDepositInstallation(
      req({ tx_hash: TX_HASH }),
      ctx,
      deps({ creditDeposit, markActive }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("active");
    expect((body["deposit"] as Record<string, unknown>)["amount_usdc"]).toBe("5.000000");
    expect(creditDeposit).toHaveBeenCalledOnce();
    expect(markActive).toHaveBeenCalledWith(ROW_ID);
  });

  it("rejects tx_hash whose sender is not the bound wallet", async () => {
    const wrongDeps = deps({
      verifier: {
        getTransactionReceipt: vi.fn(async () => ({
          status: "success" as const,
          from: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as `0x${string}`,
          to: USDC_BASE_ADDRESS as `0x${string}`,
          blockNumber: 1_000_000n,
          logs: [
            buildTransferLog({
              from: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              to: DEPOSIT_ADDR,
              valueRaw: 5_000_000n,
            }),
          ],
        })),
        getBlockNumber: vi.fn(async () => 1_000_010n),
      },
    });
    const res = await handleDepositInstallation(req({ tx_hash: TX_HASH }), ctx, wrongDeps);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("sender_mismatch");
  });

  it("rejects an amount below the minimum", async () => {
    const lowDeps = deps({
      verifier: {
        getTransactionReceipt: vi.fn(async () => ({
          status: "success" as const,
          from: WALLET as `0x${string}`,
          to: USDC_BASE_ADDRESS as `0x${string}`,
          blockNumber: 1_000_000n,
          logs: [buildTransferLog({ from: WALLET, to: DEPOSIT_ADDR, valueRaw: 1_000_000n })],
        })),
        getBlockNumber: vi.fn(async () => 1_000_010n),
      },
    });
    const res = await handleDepositInstallation(req({ tx_hash: TX_HASH }), ctx, lowDeps);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("amount_below_minimum");
  });

  it("rejects tx with insufficient confirmations", async () => {
    const recentDeps = deps({
      verifier: {
        getTransactionReceipt: vi.fn(async () => ({
          status: "success" as const,
          from: WALLET as `0x${string}`,
          to: USDC_BASE_ADDRESS as `0x${string}`,
          blockNumber: 1_000_000n,
          logs: [buildTransferLog({ from: WALLET, to: DEPOSIT_ADDR, valueRaw: 5_000_000n })],
        })),
        getBlockNumber: vi.fn(async () => 1_000_000n),
      },
    });
    const res = await handleDepositInstallation(req({ tx_hash: TX_HASH }), ctx, recentDeps);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("insufficient_confirmations");
  });

  it("idempotently treats a replayed tx_hash as success (no double credit)", async () => {
    const creditDeposit = vi.fn(async () => false); // signals already-credited
    const res = await handleDepositInstallation(
      req({ tx_hash: TX_HASH }),
      ctx,
      deps({ creditDeposit }, row({ status: "active" }), channel({ balanceUsdc: "5.000000" })),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["deposit"] as Record<string, unknown>)["credited"]).toBe(false);
    expect(creditDeposit).toHaveBeenCalledOnce();
  });

  it("returns 503 when ANTFLEET_DEPOSIT_ADDRESS is not set", async () => {
    const res = await handleDepositInstallation(
      req({ tx_hash: TX_HASH }),
      ctx,
      deps({ getDepositAddress: () => null }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("deposit_address_unconfigured");
  });

  it("rejects deposit before wallet is bound", async () => {
    const res = await handleDepositInstallation(
      req({ tx_hash: TX_HASH }),
      ctx,
      deps({}, row({ status: "pending_binding" })),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("wrong_status");
  });
});
