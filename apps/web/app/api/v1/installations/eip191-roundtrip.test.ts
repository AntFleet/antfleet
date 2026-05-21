// End-to-end EIP-191 round-trip with real viem: create a wallet, sign the
// binding challenge, hand the signature to the bind route, and confirm the
// recovered address matches. Locks in that the verifier the bind route
// imports (viem.recoverMessageAddress) accepts signatures produced by
// viem's signMessage — a regression here would silently break every agent.

import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { handleBindInstallation, type BindInstallationDeps } from "./[id]/bind/route";
import { buildBindingChallenge } from "@/lib/paywall/challenge";
import type { PaywallInstallationRow } from "@/lib/paywall/queries";

const ROW_ID = "00000000-0000-4000-8000-0000000000ee";
const PRIVATE_KEY = "0x4af1bceebf7f3634ec3cff8a2c38e51178d5d4ce585c52d6043cf866b9bb7e2c" as const;

describe("EIP-191 binding round-trip", () => {
  it("recovers the signer of a viem signMessage(challenge) call", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const wallet = account.address.toLowerCase();
    const issuedAt = new Date("2026-05-21T12:00:00.000Z");

    const challenge = buildBindingChallenge({
      installationId: ROW_ID,
      walletAddress: wallet,
      issuedAt,
    });
    const signature = await account.signMessage({ message: challenge });

    // Sanity: viem recoverMessageAddress (the same one the bind route uses)
    // must round-trip the signature back to the signer.
    const recovered = (await recoverMessageAddress({ message: challenge, signature })).toLowerCase();
    expect(recovered).toBe(wallet);

    const markBound = vi.fn(async () => undefined);
    const deps: BindInstallationDeps = {
      loadInstallation: vi.fn(
        async () =>
          ({
            id: ROW_ID,
            status: "pending_binding",
            walletAddress: wallet,
            walletProofSignature: null,
            walletBoundAt: null,
            legacyPartner: false,
            installationId: null,
            owner: null,
            repo: null,
            createdAt: issuedAt,
          }) satisfies PaywallInstallationRow,
      ),
      recoverMessageAddress,
      markBound,
      now: () => new Date(issuedAt.getTime() + 5_000),
    };

    const res = await handleBindInstallation(
      new NextRequest(`http://test.local/api/v1/installations/${ROW_ID}/bind`, {
        method: "POST",
        body: JSON.stringify({ signature }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: ROW_ID }) },
      deps,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["wallet_address"]).toBe(wallet);
    expect(markBound).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: wallet, signature }),
    );
  });

  it("rejects a signature from a different wallet", async () => {
    const realAccount = privateKeyToAccount(PRIVATE_KEY);
    const otherAccount = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    const issuedAt = new Date("2026-05-21T12:00:00.000Z");
    const claimedWallet = realAccount.address.toLowerCase();

    // The challenge embeds the *claimed* wallet, but a different wallet signs.
    const challenge = buildBindingChallenge({
      installationId: ROW_ID,
      walletAddress: claimedWallet,
      issuedAt,
    });
    const signature = await otherAccount.signMessage({ message: challenge });

    const deps: BindInstallationDeps = {
      loadInstallation: vi.fn(
        async () =>
          ({
            id: ROW_ID,
            status: "pending_binding",
            walletAddress: claimedWallet,
            walletProofSignature: null,
            walletBoundAt: null,
            legacyPartner: false,
            installationId: null,
            owner: null,
            repo: null,
            createdAt: issuedAt,
          }) satisfies PaywallInstallationRow,
      ),
      recoverMessageAddress,
      markBound: vi.fn(),
      now: () => new Date(issuedAt.getTime() + 5_000),
    };

    const res = await handleBindInstallation(
      new NextRequest(`http://test.local/api/v1/installations/${ROW_ID}/bind`, {
        method: "POST",
        body: JSON.stringify({ signature }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: ROW_ID }) },
      deps,
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("signature_mismatch");
  });
});
