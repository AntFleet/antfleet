import { describe, expect, it } from "vitest";
import {
  AUTONOMOPOLY_AGENT_TOKEN,
  FEELOCKER_FINDING_ID,
  buildFeeLockerFinding,
  parseArgs,
} from "./publish-feelocker-finding";

describe("buildFeeLockerFinding", () => {
  it("returns the canonical finding shape with null PR fields by default", () => {
    const row = buildFeeLockerFinding({});
    expect(row.findingId).toBe(FEELOCKER_FINDING_ID);
    expect(row.agentTokenAddress).toBe(AUTONOMOPOLY_AGENT_TOKEN);
    expect(row.agentName).toBe("agent-autonomopoly");
    expect(row.severity).toBe("high");
    expect(row.upstreamPrUrl).toBeNull();
    expect(row.upstreamMergedSha).toBeNull();
  });

  it("references the correct selector in the body so the live page stays consistent with PR #5", () => {
    const row = buildFeeLockerFinding({});
    expect(row.summary).toContain("0x8296535a");
    expect(row.summary).toContain("availableFees(address,address)");
    expect(row.summary).toContain("0xe7acab24");
  });

  it("plugs in upstream PR + merge SHA when provided", () => {
    const row = buildFeeLockerFinding({
      upstreamPrUrl: "https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/5",
      upstreamMergedSha: "abc1234def5678",
    });
    expect(row.upstreamPrUrl).toBe(
      "https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/5",
    );
    expect(row.upstreamMergedSha).toBe("abc1234def5678");
  });
});

describe("parseArgs", () => {
  it("defaults to insert-only mode with no flags", () => {
    expect(parseArgs([])).toEqual({ update: false, prUrl: null, mergedSha: null });
  });

  it("accepts --update --pr-url <url>", () => {
    const args = parseArgs(["--update", "--pr-url", "https://example.com/pulls/5"]);
    expect(args).toEqual({
      update: true,
      prUrl: "https://example.com/pulls/5",
      mergedSha: null,
    });
  });

  it("accepts --update --merged-sha <sha>", () => {
    const args = parseArgs(["--update", "--merged-sha", "abc1234"]);
    expect(args).toEqual({
      update: true,
      prUrl: null,
      mergedSha: "abc1234",
    });
  });

  it("rejects --pr-url without --update", () => {
    expect(() => parseArgs(["--pr-url", "https://example.com"])).toThrow(/--update/);
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
  });
});
