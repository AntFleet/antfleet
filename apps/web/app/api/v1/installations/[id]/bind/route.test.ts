import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { handleBindInstallation, type BindInstallationDeps } from "./route";
import type { PaywallInstallationRow } from "@/lib/paywall/queries";

const ROW_ID = "00000000-0000-4000-8000-000000000001";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const OTHER_WALLET = "0x1111111111111111111111111111111111111111";
const SIG = `0x${"a".repeat(130)}`;
const CREATED_AT = new Date("2026-05-21T12:00:00.000Z");
const NOW = new Date("2026-05-21T12:00:30.000Z");

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
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function deps(
  overrides: Partial<BindInstallationDeps> = {},
  loaded: PaywallInstallationRow | null = row(),
): BindInstallationDeps {
  return {
    loadInstallation: vi.fn(async () => loaded),
    recoverMessageAddress: vi.fn(async () => WALLET),
    markBound: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides,
  };
}

function req(body: unknown): NextRequest {
  return new NextRequest(`http://test.local/api/v1/installations/${ROW_ID}/bind`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: Promise.resolve({ id: ROW_ID }) };

describe("POST /api/v1/installations/{id}/bind", () => {
  it("verifies signature and transitions to awaiting_deposit", async () => {
    const markBound = vi.fn(async () => undefined);
    const res = await handleBindInstallation(req({ signature: SIG }), ctx, deps({ markBound }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("awaiting_deposit");
    expect(body["wallet_address"]).toBe(WALLET);
    expect(markBound).toHaveBeenCalledOnce();
    expect(markBound.mock.calls[0]?.[0]).toMatchObject({
      installationRowId: ROW_ID,
      walletAddress: WALLET,
      signature: SIG,
    });
    expect((body["next_step"] as Record<string, unknown>)["method"]).toBe("POST");
  });

  it("rejects when recovered address does not match claimed wallet", async () => {
    const res = await handleBindInstallation(
      req({ signature: SIG }),
      ctx,
      deps({ recoverMessageAddress: vi.fn(async () => OTHER_WALLET) }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("signature_mismatch");
  });

  it("rejects when status is not pending_binding", async () => {
    const res = await handleBindInstallation(
      req({ signature: SIG }),
      ctx,
      deps({}, row({ status: "awaiting_deposit" })),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("wrong_status");
  });

  it("rejects when the row does not exist", async () => {
    const res = await handleBindInstallation(req({ signature: SIG }), ctx, deps({}, null));
    expect(res.status).toBe(404);
  });

  it("rejects when challenge is older than the max age", async () => {
    const ancient = new Date(NOW.getTime() - 11 * 60 * 1000);
    const res = await handleBindInstallation(
      req({ signature: SIG }),
      ctx,
      deps({}, row({ createdAt: ancient })),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("stale_challenge");
  });

  it("rejects malformed signature", async () => {
    const res = await handleBindInstallation(req({ signature: "0xshort" }), ctx, deps());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  it("returns 400 if viem cannot recover an address", async () => {
    const res = await handleBindInstallation(
      req({ signature: SIG }),
      ctx,
      deps({
        recoverMessageAddress: vi.fn(async () => {
          throw new Error("invalid signature");
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_signature");
  });
});
