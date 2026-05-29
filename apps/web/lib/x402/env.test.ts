import { describe, expect, it } from "vitest";
import {
  loadX402Config,
  X402_SEPOLIA_FACILITATOR,
  X402_SEPOLIA_NETWORK,
  X402_SEPOLIA_USDC,
} from "./env";

const baseEnv = {
  X402_NETWORK: X402_SEPOLIA_NETWORK,
  X402_USDC_ASSET: X402_SEPOLIA_USDC,
  X402_FACILITATOR: X402_SEPOLIA_FACILITATOR,
  ANTFLEET_X402_TREASURY: "0x000000000000000000000000000000000000dEaD",
};

describe("loadX402Config", () => {
  it("loads the pinned Base Sepolia config", () => {
    const config = loadX402Config(baseEnv);

    expect(config.network).toBe("eip155:84532");
    expect(config.priceBaseUnits).toBe("500000");
    expect(config.treasury).toBe("0x000000000000000000000000000000000000dEaD");
  });

  it("fails closed on network/asset mismatch", () => {
    expect(() =>
      loadX402Config({
        ...baseEnv,
        X402_USDC_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      }),
    ).toThrow(/Base USDC pair/);
  });

  it("validates the optional x402 wall-clock timeout override", () => {
    expect(() =>
      loadX402Config({
        ...baseEnv,
        X402_MAX_TIMEOUT_SECONDS: "0",
      }),
    ).toThrow(/X402_MAX_TIMEOUT_SECONDS/);
  });
});
