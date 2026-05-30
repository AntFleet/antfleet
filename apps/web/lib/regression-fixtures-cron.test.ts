import { describe, it, expect } from "vitest";
import { runRegressionFixtures, type FixtureReviewer } from "./regression-fixtures-cron";
import {
  REGRESSION_FIXTURES,
  fixtureFilename,
  type RegressionFixture,
} from "./__regression_fixtures__";
import type { Finding } from "./review-types";

const fx = (id: string, language = "typescript"): RegressionFixture => ({
  id,
  language,
  description: "safe pattern",
  code: "const x = 1;\n",
});

const cleanReviewer: FixtureReviewer = async () => ({
  agreed: [],
  degraded: false,
  degradedReason: null,
});

describe("REGRESSION_FIXTURES", () => {
  it("ships at least 5 fixtures with unique ids and real code + descriptions", () => {
    expect(REGRESSION_FIXTURES.length).toBeGreaterThanOrEqual(5);
    const ids = REGRESSION_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    for (const f of REGRESSION_FIXTURES) {
      expect(f.code.trim().length).toBeGreaterThan(0);
      expect(f.description.trim().length).toBeGreaterThan(0);
      expect(f.language.length).toBeGreaterThan(0);
    }
  });

  it("derives a sensible filename per language", () => {
    expect(fixtureFilename(fx("a", "rust"))).toBe("a.rs");
    expect(fixtureFilename(fx("b", "solidity"))).toBe("b.sol");
    expect(fixtureFilename(fx("c", "klingon"))).toBe("c.txt"); // unknown → .txt
  });
});

describe("runRegressionFixtures", () => {
  it("passes every fixture when the gate fires on none", async () => {
    const res = await runRegressionFixtures(cleanReviewer, [fx("a"), fx("b")]);
    expect(res).toMatchObject({ ran: 2, passed: 2, failed: 0, degraded: 0, failures: [] });
  });

  it("fails (and lists) the fixture whose unanimous gate fired", async () => {
    const reviewer: FixtureReviewer = async (f) =>
      f.id === "a"
        ? { agreed: [{} as Finding], degraded: false, degradedReason: null }
        : { agreed: [], degraded: false, degradedReason: null };
    const res = await runRegressionFixtures(reviewer, [fx("a"), fx("b")]);
    expect(res.failed).toBe(1);
    expect(res.failures).toEqual(["a"]);
    expect(res.passed).toBe(1);
  });

  it("treats a degraded review as inconclusive, not a failure", async () => {
    const reviewer: FixtureReviewer = async () => ({
      agreed: [],
      degraded: true,
      degradedReason: "1/2 providers succeeded",
    });
    const res = await runRegressionFixtures(reviewer, [fx("a")]);
    expect(res.failed).toBe(0);
    expect(res.degraded).toBe(1);
    expect(res.degradedFixtures).toEqual(["a"]);
  });

  it("defaults to the shipped REGRESSION_FIXTURES list", async () => {
    const res = await runRegressionFixtures(cleanReviewer);
    expect(res.ran).toBe(REGRESSION_FIXTURES.length);
    expect(res.failed).toBe(0);
  });
});
