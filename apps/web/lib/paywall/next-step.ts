// next_step is the single field an agent reads to drive itself through the
// paywall flow without any AntFleet-specific knowledge. Each block carries
// a human-readable hint, the HTTP method and absolute URL to call next, and
// a body_schema that names each field the endpoint expects. The format is
// stable across responses so an agent can poll GET /v1/installations/{id}
// and walk forward purely on next_step.

import {
  getDepositAddress,
  getGitHubAppInstallUrl,
  getMinDepositUsdc,
  getPublicBaseUrl,
  USDC_BASE_ADDRESS,
} from "./env";
import { PAYWALL_STATUS, type PaywallStatus } from "./state";

export type NextStep = {
  human: string;
  method: "POST" | "GET" | "INSTALL";
  url: string;
  body_schema: Record<string, string> | null;
};

export type NextStepInput =
  | { status: typeof PAYWALL_STATUS.pendingBinding; installationId: string; challenge: string }
  | { status: typeof PAYWALL_STATUS.awaitingDeposit; installationId: string }
  | { status: typeof PAYWALL_STATUS.active; installationId: string }
  | { status: "linked"; installationId: string };

export function buildNextStep(input: NextStepInput): NextStep {
  const base = getPublicBaseUrl();
  switch (input.status) {
    case PAYWALL_STATUS.pendingBinding:
      return {
        human: `Sign this EIP-191 personal_sign message with the wallet you POSTed and submit the signature to /v1/installations/${input.installationId}/bind: "${input.challenge}"`,
        method: "POST",
        url: `${base}/api/v1/installations/${input.installationId}/bind`,
        body_schema: { signature: "0x-prefixed EIP-191 personal_sign over the challenge string" },
      };
    case PAYWALL_STATUS.awaitingDeposit: {
      const depositAddress = getDepositAddress();
      const minDeposit = getMinDepositUsdc();
      return {
        human:
          depositAddress === null
            ? "Deposit address is not configured yet. Wait and poll GET /v1/installations/{id} for an updated next_step."
            : `Send ≥ ${minDeposit} USDC on Base (chain 8453, token ${USDC_BASE_ADDRESS}) from your bound wallet to ${depositAddress}, then POST the tx hash to /v1/installations/${input.installationId}/deposit.`,
        method: "POST",
        url: `${base}/api/v1/installations/${input.installationId}/deposit`,
        body_schema: { tx_hash: "0x-prefixed Base mainnet transaction hash of the USDC Transfer" },
      };
    }
    case PAYWALL_STATUS.active: {
      // Install URL carries the installation row id as `state` so the
      // post-install webhook delivery can link the GitHub installation_id
      // back to this row. Setup URL on the GitHub App side echoes `state`.
      const installUrl = `${getGitHubAppInstallUrl()}?state=${input.installationId}`;
      return {
        human: `Channel funded. Install the AntFleet GitHub App on the repo you want reviewed: ${installUrl}`,
        method: "INSTALL",
        url: installUrl,
        body_schema: null,
      };
    }
    case "linked":
      return {
        human:
          "GitHub App installed and channel active. Open a PR — reviews will draw down from the channel automatically.",
        method: "GET",
        url: `${base}/api/v1/installations/${input.installationId}`,
        body_schema: null,
      };
  }
}
