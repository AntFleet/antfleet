import { describe, expect, it } from "vitest";
import { buildInvoice, renderInvoiceComment } from "./invoice";

describe("buildInvoice", () => {
  it("produces an x402 v1 accepts entry with the expected fields", () => {
    const invoice = buildInvoice({
      topUpUsdc: "5.00",
      depositAddress: "0xdeposit",
      walletAddress: "0xwallet",
    });
    expect(invoice.x402Version).toBe(1);
    expect(invoice.accepts).toHaveLength(1);
    const a = invoice.accepts[0]!;
    expect(a.scheme).toBe("exact");
    expect(a.network).toBe("base");
    expect(a.chainId).toBe(8453);
    expect(a.payTo).toBe("0xdeposit");
    expect(a.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    // 5.00 USDC at 6 decimals = 5_000_000 base units
    expect(a.maxAmountRequired).toBe("5000000");
    expect(a.extra.name).toBe("USDC");
  });

  it("encodes fractional USDC amounts correctly", () => {
    const invoice = buildInvoice({
      topUpUsdc: "0.50",
      depositAddress: "0xdeposit",
      walletAddress: "0xwallet",
    });
    expect(invoice.accepts[0]!.maxAmountRequired).toBe("500000");
  });
});

describe("renderInvoiceComment", () => {
  it("includes top-up amount, deposit address, and a JSON fenced block", () => {
    const invoice = buildInvoice({
      topUpUsdc: "5.00",
      depositAddress: "0xdeposit",
      walletAddress: "0xwallet",
    });
    const body = renderInvoiceComment({
      invoice,
      depositAddress: "0xdeposit",
      walletAddress: "0xwallet",
      topUpUsdc: "5.00",
      currentBalanceUsdc: "0.20",
      priceUsdc: "0.50",
    });
    expect(body).toContain("AntFleet · channel below review price");
    expect(body).toContain("0.20 USDC");
    expect(body).toContain("0.50 USDC");
    expect(body).toContain("5.00 USDC on Base");
    expect(body).toContain("0xdeposit");
    expect(body).toContain("0xwallet");
    expect(body).toContain("```json");
    expect(body).toContain('"x402Version": 1');
  });
});
