import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /.well-known/antfleet.json", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env["ANTFLEET_PUBLIC_BASE_URL"] = "https://www.antfleet.dev";
    process.env["ANTFLEET_DEPOSIT_ADDRESS"] = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env["REVIEW_PRICE_USDC"] = "0.50";
    process.env["MIN_DEPOSIT_USDC"] = "5.00";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns the documented manifest shape", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["service"]).toBe("antfleet");
    expect(body["version"]).toBe(1);
    expect(body["chain_id"]).toBe(8453);
    expect(body["price_per_review_usdc"]).toBe("0.50");
    expect(body["min_deposit_usdc"]).toBe("5.00");
    expect(body["deposit_address"]).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const endpoints = body["endpoints"] as Record<string, string>;
    expect(endpoints["create_installation"]).toBe(
      "https://www.antfleet.dev/api/v1/installations",
    );
    expect(endpoints["bind_wallet"]).toContain("/bind");
    expect(endpoints["submit_deposit"]).toContain("/deposit");
    const token = body["payment_token"] as Record<string, unknown>;
    expect(token["symbol"]).toBe("USDC");
    expect(token["decimals"]).toBe(6);
  });

  it("returns deposit_address: null when not configured", async () => {
    delete process.env["ANTFLEET_DEPOSIT_ADDRESS"];
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["deposit_address"]).toBeNull();
  });
});
