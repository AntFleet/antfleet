import { describe, expect, it } from "vitest";
import { databaseHostForLog, resolveApplyPlan } from "./safety";

const DEV_URL = "postgresql://user:pw@ep-crimson-hall-aq6bfx9d.us-east-1.aws.neon.tech/neondb";

describe("databaseHostForLog", () => {
  it("returns the host portion of a postgres URL", () => {
    expect(databaseHostForLog(DEV_URL)).toBe("ep-crimson-hall-aq6bfx9d.us-east-1.aws.neon.tech");
  });

  it("returns a sentinel on an unparseable URL", () => {
    expect(databaseHostForLog("not a url")).toBe("(unparseable DATABASE_URL)");
  });
});

describe("resolveApplyPlan", () => {
  it("fails fast when DATABASE_URL is missing", () => {
    const result = resolveApplyPlan({ argv: ["node", "x", "--apply"], env: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("DATABASE_URL");
  });

  it("allows a dry-run (no --apply) without ALLOW_PROD_APPLY", () => {
    const result = resolveApplyPlan({
      argv: ["node", "x"],
      env: { DATABASE_URL: DEV_URL },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apply).toBe(false);
  });

  it("allows a dry-run with no DATABASE_URL at all", () => {
    // Dry-run prints SQL and exits without touching the DB. Requiring an
    // env var just to read the migration script breaks the documented
    // review workflow; only --apply needs DB connectivity.
    const result = resolveApplyPlan({ argv: ["node", "x"], env: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.apply).toBe(false);
      expect(result.host).toContain("dry-run");
    }
  });

  it("refuses --apply without ALLOW_PROD_APPLY=1 and names the host in the message", () => {
    const result = resolveApplyPlan({
      argv: ["node", "x", "--apply"],
      env: { DATABASE_URL: DEV_URL },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("ALLOW_PROD_APPLY");
      expect(result.reason).toContain("ep-crimson-hall-aq6bfx9d.us-east-1.aws.neon.tech");
    }
  });

  it("permits --apply when ALLOW_PROD_APPLY=1 is set", () => {
    const result = resolveApplyPlan({
      argv: ["node", "x", "--apply"],
      env: { DATABASE_URL: DEV_URL, ALLOW_PROD_APPLY: "1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apply).toBe(true);
  });

  it("does not treat ALLOW_PROD_APPLY=0 or 'true' as opt-in", () => {
    for (const value of ["0", "true", "yes", ""]) {
      const result = resolveApplyPlan({
        argv: ["node", "x", "--apply"],
        env: { DATABASE_URL: DEV_URL, ALLOW_PROD_APPLY: value },
      });
      expect(result.ok).toBe(false);
    }
  });
});
