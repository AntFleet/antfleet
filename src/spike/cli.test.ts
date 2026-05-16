import { describe, it, expect } from "vitest";
import { parseSpikeArgs, DEFAULT_SPIKE_ARGS } from "./cli.js";
import { FleetError } from "../errors.js";

describe("parseSpikeArgs", () => {
  it("returns defaults for empty argv", () => {
    expect(parseSpikeArgs([])).toEqual(DEFAULT_SPIKE_ARGS);
  });

  it("parses --runs as a positive integer", () => {
    expect(parseSpikeArgs(["--runs", "5"]).runs).toBe(5);
    expect(parseSpikeArgs(["--runs", "1"]).runs).toBe(1);
  });

  it("rejects --runs 0, negative, and non-numeric", () => {
    expect(() => parseSpikeArgs(["--runs", "0"])).toThrow(FleetError);
    expect(() => parseSpikeArgs(["--runs", "-3"])).toThrow(/positive integer/u);
    expect(() => parseSpikeArgs(["--runs", "abc"])).toThrow(/positive integer/u);
  });

  it("parses --providers as a comma-separated list", () => {
    expect(parseSpikeArgs(["--providers", "anthropic,openai,openrouter"]).providers).toEqual([
      "anthropic",
      "openai",
      "openrouter",
    ]);
  });

  it("trims whitespace and drops empty entries in --providers", () => {
    expect(parseSpikeArgs(["--providers", " anthropic , , openrouter "]).providers).toEqual([
      "anthropic",
      "openrouter",
    ]);
  });

  it("rejects an empty --providers list", () => {
    expect(() => parseSpikeArgs(["--providers", ""])).toThrow(/non-empty/u);
    expect(() => parseSpikeArgs(["--providers", ", ,"])).toThrow(/non-empty/u);
  });

  it("parses --mode and rejects invalid values", () => {
    expect(parseSpikeArgs(["--mode", "majority"]).mode).toBe("majority");
    expect(parseSpikeArgs(["--mode", "any"]).mode).toBe("any");
    expect(() => parseSpikeArgs(["--mode", "consensus"])).toThrow(/unanimous|majority|any/u);
  });

  it("parses --ceiling as a positive float", () => {
    expect(parseSpikeArgs(["--ceiling", "2.5"]).costCeilingUsd).toBeCloseTo(2.5);
    expect(parseSpikeArgs(["--ceiling", "10"]).costCeilingUsd).toBe(10);
  });

  it("rejects --ceiling 0, negative, and non-numeric", () => {
    expect(() => parseSpikeArgs(["--ceiling", "0"])).toThrow(/positive number/u);
    expect(() => parseSpikeArgs(["--ceiling", "-1"])).toThrow(/positive number/u);
    expect(() => parseSpikeArgs(["--ceiling", "x"])).toThrow(/positive number/u);
  });

  it("rejects flags that consume a value when the value is missing", () => {
    expect(() => parseSpikeArgs(["--runs"])).toThrow(/requires a value/u);
    expect(() => parseSpikeArgs(["--mode"])).toThrow(/requires a value/u);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseSpikeArgs(["--bogus"])).toThrow(/unknown argument/u);
  });

  it("composes flags together", () => {
    const args = parseSpikeArgs([
      "--runs",
      "3",
      "--providers",
      "anthropic,openrouter",
      "--mode",
      "majority",
      "--ceiling",
      "2",
    ]);
    expect(args).toEqual({
      runs: 3,
      providers: ["anthropic", "openrouter"],
      mode: "majority",
      costCeilingUsd: 2,
      corpus: null,
    });
  });

  it("parses --corpus as a path", () => {
    const args = parseSpikeArgs(["--corpus", "examples/antseed-corpus"]);
    expect(args.corpus).toBe("examples/antseed-corpus");
  });

  it("rejects an empty --corpus value", () => {
    expect(() => parseSpikeArgs(["--corpus", ""])).toThrow(/requires a value|non-empty/u);
  });
});
