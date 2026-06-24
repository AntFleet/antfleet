import { describe, expect, it } from "vitest";
import { parseArgs } from "./mint-sarif-ingest-token";

describe("mint-sarif-ingest-token parseArgs", () => {
  it("parses long-form flags", () => {
    expect(
      parseArgs(["--installation", "133030324", "--owner", "AntFleet", "--repo", "bench-orlixai"]),
    ).toEqual({
      installationId: 133030324,
      owner: "AntFleet",
      repo: "bench-orlixai",
    });
  });

  it("parses short-form flags", () => {
    expect(parseArgs(["-i", "42", "-o", "AntFleet", "-r", "bench"])).toEqual({
      installationId: 42,
      owner: "AntFleet",
      repo: "bench",
    });
  });

  it("returns null when installation is missing", () => {
    expect(parseArgs(["--owner", "AntFleet", "--repo", "bench"])).toBeNull();
  });

  it("returns null when installation is not a positive integer", () => {
    expect(parseArgs(["--installation", "not-a-number", "--owner", "x", "--repo", "y"])).toBeNull();
    expect(parseArgs(["--installation", "-1", "--owner", "x", "--repo", "y"])).toBeNull();
  });

  it("returns null when owner or repo is empty", () => {
    expect(parseArgs(["--installation", "1", "--owner", "", "--repo", "bench"])).toBeNull();
    expect(parseArgs(["--installation", "1", "--owner", "AntFleet", "--repo", ""])).toBeNull();
  });

  it("ignores trailing dangling flags without value", () => {
    expect(parseArgs(["--owner"])).toBeNull();
  });
});
