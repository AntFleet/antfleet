import { describe, it, expect, afterEach } from "vitest";
import {
  isEvidenceBundleEnabled,
  isEvidenceBundleEnabledForInstall,
  isDisclosureGateEnabled,
  isDisclosureGateEnabledForInstall,
  isDisclosureSideTableEnabled,
  isReachabilityGateEnabled,
  isPatchVerifyEnabled,
  isThreatModelEnabled,
  isReachabilityGateEnabledForInstall,
  isPatchVerifyEnabledForInstall,
  isThreatModelEnabledForInstall,
} from "./daybreak-gates-env";

const KEYS = [
  "ANTFLEET_REACHABILITY_GATE",
  "ANTFLEET_PATCH_VERIFY",
  "ANTFLEET_THREAT_MODEL",
  "ANTFLEET_EVIDENCE_BUNDLE",
  "ANTFLEET_DISCLOSURE_GATE",
  "ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE",
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("daybreak-gates-env", () => {
  it("both flags default to false when env is unset", () => {
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isThreatModelEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
    expect(isDisclosureGateEnabled()).toBe(false);
  });

  it("ANTFLEET_REACHABILITY_GATE=true enables reachability only", () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = "true";
    expect(isReachabilityGateEnabled()).toBe(true);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isThreatModelEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
    expect(isDisclosureGateEnabled()).toBe(false);
  });

  it("ANTFLEET_PATCH_VERIFY=1 enables patch verify only", () => {
    process.env["ANTFLEET_PATCH_VERIFY"] = "1";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(true);
    expect(isThreatModelEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
    expect(isDisclosureGateEnabled()).toBe(false);
  });

  it("ANTFLEET_THREAT_MODEL=yes enables threat model only", () => {
    process.env["ANTFLEET_THREAT_MODEL"] = "yes";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isThreatModelEnabled()).toBe(true);
    expect(isEvidenceBundleEnabled()).toBe(false);
    expect(isDisclosureGateEnabled()).toBe(false);
  });

  it("ANTFLEET_EVIDENCE_BUNDLE=on enables evidence bundles only", () => {
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "on";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isThreatModelEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(true);
    expect(isDisclosureGateEnabled()).toBe(false);
  });

  it("ANTFLEET_DISCLOSURE_GATE requires backfill completion", () => {
    process.env["ANTFLEET_DISCLOSURE_GATE"] = "true";
    expect(isDisclosureGateEnabled()).toBe(false);
    expect(isDisclosureSideTableEnabled()).toBe(false);
    process.env["ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE"] = "true";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isThreatModelEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
    expect(isDisclosureSideTableEnabled()).toBe(true);
    expect(isDisclosureGateEnabled()).toBe(true);
  });

  it("flags are case-insensitive and trim whitespace", () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = " TRUE ";
    process.env["ANTFLEET_PATCH_VERIFY"] = "Yes";
    process.env["ANTFLEET_THREAT_MODEL"] = "1";
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "ON";
    process.env["ANTFLEET_DISCLOSURE_GATE"] = "true";
    process.env["ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE"] = "true";
    expect(isReachabilityGateEnabled()).toBe(true);
    expect(isPatchVerifyEnabled()).toBe(true);
    expect(isThreatModelEnabled()).toBe(true);
    expect(isEvidenceBundleEnabled()).toBe(true);
    expect(isDisclosureGateEnabled()).toBe(true);
  });

  it("unknown values read as disabled (fail-closed)", () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = "maybe";
    process.env["ANTFLEET_PATCH_VERIFY"] = "0";
    process.env["ANTFLEET_THREAT_MODEL"] = "false";
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "nope";
    process.env["ANTFLEET_DISCLOSURE_GATE"] = "later";
    expect(isReachabilityGateEnabled()).toBe(false);
    expect(isPatchVerifyEnabled()).toBe(false);
    expect(isThreatModelEnabled()).toBe(false);
    expect(isEvidenceBundleEnabled()).toBe(false);
    expect(isDisclosureGateEnabled()).toBe(false);
  });

  it("per-install resolvers currently mirror the env flag", async () => {
    process.env["ANTFLEET_REACHABILITY_GATE"] = "true";
    process.env["ANTFLEET_PATCH_VERIFY"] = "false";
    process.env["ANTFLEET_THREAT_MODEL"] = "true";
    process.env["ANTFLEET_EVIDENCE_BUNDLE"] = "true";
    process.env["ANTFLEET_DISCLOSURE_GATE"] = "true";
    process.env["ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE"] = "true";
    await expect(isReachabilityGateEnabledForInstall(1, "owner/repo")).resolves.toBe(true);
    await expect(isPatchVerifyEnabledForInstall(1, "owner/repo")).resolves.toBe(false);
    await expect(isThreatModelEnabledForInstall(1, "owner/repo")).resolves.toBe(true);
    await expect(isEvidenceBundleEnabledForInstall(1, "owner/repo")).resolves.toBe(true);
    await expect(isDisclosureGateEnabledForInstall(1, "owner/repo")).resolves.toBe(true);
  });
});
