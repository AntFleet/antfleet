import { describe, expect, it, vi } from "vitest";
import { handleGetInstallation, type GetInstallationDeps } from "./route";
import type { PaywallChannelRow, PaywallInstallationRow } from "@/lib/paywall/queries";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function row(overrides: Partial<PaywallInstallationRow> = {}): PaywallInstallationRow {
  return {
    id: ROW_ID,
    status: "pending_binding",
    walletAddress: WALLET,
    walletProofSignature: null,
    walletBoundAt: null,
    legacyPartner: false,
    installationId: null,
    owner: null,
    repo: null,
    createdAt: new Date("2026-05-21T12:00:00.000Z"),
    ...overrides,
  };
}

function deps(
  loadedRow: PaywallInstallationRow | null = row(),
  loadedChannel: PaywallChannelRow | null = null,
): GetInstallationDeps {
  return {
    loadInstallation: vi.fn(async () => loadedRow),
    loadChannel: vi.fn(async () => loadedChannel),
  };
}

const ctx = { params: Promise.resolve({ id: ROW_ID }) };

describe("GET /api/v1/installations/{id}", () => {
  it("returns next_step pointing at /bind for pending_binding rows", async () => {
    const res = await handleGetInstallation(ctx, deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("pending_binding");
    expect((body["next_step"] as Record<string, unknown>)["url"]).toContain(
      `/api/v1/installations/${ROW_ID}/bind`,
    );
  });

  it("returns next_step pointing at /deposit for awaiting_deposit rows", async () => {
    const res = await handleGetInstallation(ctx, deps(row({ status: "awaiting_deposit" })));
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["next_step"] as Record<string, unknown>)["url"]).toContain(
      `/api/v1/installations/${ROW_ID}/deposit`,
    );
  });

  it("returns GitHub App install URL for active-not-yet-linked rows", async () => {
    const res = await handleGetInstallation(ctx, deps(row({ status: "active" })));
    const body = (await res.json()) as Record<string, unknown>;
    const nextStep = body["next_step"] as Record<string, unknown>;
    expect(nextStep["method"]).toBe("INSTALL");
    expect(nextStep["url"] as string).toContain("github.com/apps/antfleet");
    expect(nextStep["url"] as string).toContain(`state=${ROW_ID}`);
  });

  it("returns 404 for missing row", async () => {
    const res = await handleGetInstallation(ctx, deps(null));
    expect(res.status).toBe(404);
  });

  it("rejects non-UUID id", async () => {
    const res = await handleGetInstallation(
      { params: Promise.resolve({ id: "not-a-uuid" }) },
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("includes channel balance when a channel exists", async () => {
    const res = await handleGetInstallation(
      ctx,
      deps(row({ status: "active" }), {
        id: "channel-id",
        installationId: ROW_ID,
        walletAddress: WALLET,
        balanceUsdc: "4.500000",
        createdAt: new Date(),
        lastDepositTxHash: "0xabc",
        lastDrawdownAt: null,
      }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    const ch = body["channel"] as Record<string, unknown>;
    expect(ch["balance_usdc"]).toBe("4.500000");
  });
});
