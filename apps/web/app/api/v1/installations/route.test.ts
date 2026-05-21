import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { handleCreateInstallation, type CreateInstallationDeps } from "./route";
import type { PaywallInstallationRow } from "@/lib/paywall/queries";

const FIXED_NOW = new Date("2026-05-21T12:00:00.000Z");
const FIXED_ROW_ID = "00000000-0000-4000-8000-000000000001";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function deps(): CreateInstallationDeps {
  return {
    async insertInstallation(args): Promise<PaywallInstallationRow> {
      return {
        id: FIXED_ROW_ID,
        status: "pending_binding",
        walletAddress: args.walletAddress,
        walletProofSignature: null,
        walletBoundAt: null,
        legacyPartner: false,
        installationId: null,
        owner: null,
        repo: null,
        createdAt: FIXED_NOW,
      };
    },
    now: () => FIXED_NOW,
  };
}

function req(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/v1/installations", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/installations", () => {
  it("creates a pending_binding row and returns a binding challenge + next_step", async () => {
    const res = await handleCreateInstallation(req({ wallet_address: WALLET }), deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["installation_id"]).toBe(FIXED_ROW_ID);
    expect(body["status"]).toBe("pending_binding");
    expect(body["wallet_address"]).toBe(WALLET);
    expect(body["binding_challenge"]).toBe(
      `AntFleet binding: ${FIXED_ROW_ID} ${WALLET} ${FIXED_NOW.toISOString()}`,
    );
    const nextStep = body["next_step"] as Record<string, unknown>;
    expect(nextStep["method"]).toBe("POST");
    expect(nextStep["url"]).toContain(`/api/v1/installations/${FIXED_ROW_ID}/bind`);
    expect((nextStep["body_schema"] as Record<string, string>)["signature"]).toContain(
      "EIP-191",
    );
  });

  it("rejects a non-hex wallet_address", async () => {
    const res = await handleCreateInstallation(req({ wallet_address: "not-an-address" }), deps());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  it("rejects missing body", async () => {
    const res = await handleCreateInstallation(
      new NextRequest("http://test.local/api/v1/installations", { method: "POST" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });

  it("normalizes wallet_address to lowercase", async () => {
    const res = await handleCreateInstallation(
      req({ wallet_address: WALLET.toUpperCase().replace("0X", "0x") }),
      deps(),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["wallet_address"]).toBe(WALLET);
  });
});
