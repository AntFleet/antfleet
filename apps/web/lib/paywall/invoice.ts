// x402-shaped invoice rendering for the GitHub PR comment posted when a
// channel is below REVIEW_PRICE_USDC. The body matches the x402 v1
// `accepts` shape so a downstream agent can parse the JSON, generate the
// USDC transfer, and resume. No HTML — just a fenced JSON block + a one-
// line human hint.

import { BASE_CHAIN_ID, USDC_BASE_ADDRESS } from "./env";

export type X402Invoice = {
  x402Version: 1;
  accepts: Array<{
    scheme: "exact";
    network: "base";
    chainId: number;
    asset: string;
    payTo: string;
    maxAmountRequired: string; // base units (6 decimals) as decimal string
    resource: string;
    description: string;
    extra: { name: "USDC"; version: "2" };
  }>;
};

export function buildInvoice(args: {
  topUpUsdc: string;
  depositAddress: string;
  walletAddress: string;
}): X402Invoice {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        chainId: BASE_CHAIN_ID,
        asset: USDC_BASE_ADDRESS,
        payTo: args.depositAddress,
        maxAmountRequired: toBaseUnits(args.topUpUsdc),
        resource: "antfleet:review",
        description: `Top up the AntFleet channel for wallet ${args.walletAddress}`,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

export function renderInvoiceComment(args: {
  invoice: X402Invoice;
  depositAddress: string;
  walletAddress: string;
  topUpUsdc: string;
  currentBalanceUsdc: string;
  priceUsdc: string;
}): string {
  return [
    `**AntFleet · channel below review price**`,
    "",
    `Channel balance is **${args.currentBalanceUsdc} USDC**, per-review price is **${args.priceUsdc} USDC**. This PR was not reviewed.`,
    "",
    `Top up: send at least **${args.topUpUsdc} USDC on Base** to \`${args.depositAddress}\` from your bound wallet \`${args.walletAddress}\`. The next deposit auto-credits this channel and the next PR webhook will run.`,
    "",
    "```json",
    JSON.stringify(args.invoice, null, 2),
    "```",
  ].join("\n");
}

function toBaseUnits(decimalString: string): string {
  const [whole, frac = ""] = decimalString.split(".");
  if (whole === undefined) throw new Error(`invalid USDC: ${decimalString}`);
  const padded = (frac + "000000").slice(0, 6);
  return (BigInt(whole) * 1_000_000n + BigInt(padded || "0")).toString();
}
