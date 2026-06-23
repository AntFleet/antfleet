import { describe, it, expect, afterEach } from "vitest";
import {
  isEvidenceBundleEnabled,
  isEvidenceBundleEnabledForInstall,
  isReachabilityGateEnabled,
  isPatchVerifyEnabled,
  isReachabilityGateEnabledForInstall,
  isPatchVerifyEnabledForInstall,
} from "./daybreak-gates-env";

const KEYS = ["ANTFLEET_REACHABILITY_GATE", "ANTFLEET_PATCH_VERIFY", "ANTFLEET_EVIDENCE_BUNDLE"];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("daybreak-gates-env", () => {
  it("both flags default to false when env is unset", () => {
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
  });

  it("ANTFLEET_REACHABILITY_GATE=true enables reachability only", () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = "true";
    expect(isReachabilityGateEnabled()).toBe(true);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
  });

  it("ANTFLEET_PATCH_VERIFY=1 enables patch verify only", () => {
    process.env["ANTFLEET_PATCH_VERIFY"] = "1";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(true);
    expect(isEvidenceBundleEnabled()).toBe(false);
  });

  it("ANTFLEET_EVIDENCE_BUNDLE=on enables evidence bundles only", () => {
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "on";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(true);
  });

  it("flags are case-insensitive and trim whitespace", () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = " TRUE ";
    process.env["ANTFLEET_PATCH_VERIFY"] = "Yes";
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "ON";
    expect(isReachabilityGateEnabled()).toBe(true);
    expect(isPatchVerifyEnabled()).toBe(true);
    expect(isEvidenceBundleEnabled()).toBe(true);
  });

  it("unknown values read as disabled (fail-closed)", () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = "maybe";
    process.env["ANTFLEET_PATCH_VERIFY"] = "0";
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "nope";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
  });

  it("per-install resolvers currently mirror the env flag", async () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = "true";
    process.env["ANTFLEET_PATCH_VERIFY"] = "false";
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "true";
    await expect(isReachabilityGateEnabledForInstall(1, "owner/repo")).resolves.toBe(true);
    await expect(isPatchVerifyEnabledForInstall(1, "owner/repo")).resolves.toBe(false);
    await expect(isEvidenceBundleEnabledForInstall(1, "owner/repo")).resolves.toBe(true);
  });
});
