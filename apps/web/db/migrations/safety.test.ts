import { describe, expect, it } from "vitest";
import { databaseHostForLog, resolveApplyPlan, splitSqlStatements } from "./safety";

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

describe("splitSqlStatements", () => {
  it("splits simple statements on semicolons", () => {
    const sql = "CREATE TABLE a (id int); CREATE TABLE b (id int);";
    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE a (id int)", "CREATE TABLE b (id int)"]);
  });

  it("trims whitespace and drops empty trailing fragments", () => {
    expect(splitSqlStatements("SELECT 1;\n\n  ")).toEqual(["SELECT 1"]);
    expect(splitSqlStatements("   ")).toEqual([]);
  });

  it("preserves a single statement that has no trailing semicolon", () => {
    expect(splitSqlStatements("SELECT 1")).toEqual(["SELECT 1"]);
  });

  it("does not split on semicolons inside single-quoted strings", () => {
    // Reproduces the migration 0047 COMMENT bug: the body has an inline
    // semicolon, the old splitter cut the string in half and Postgres
    // raised "unterminated quoted string".
    const sql =
      "COMMENT ON TABLE foo IS 'guard; cron purges old rows.';\nCREATE INDEX bar ON foo (x);";
    expect(splitSqlStatements(sql)).toEqual([
      "COMMENT ON TABLE foo IS 'guard; cron purges old rows.'",
      "CREATE INDEX bar ON foo (x)",
    ]);
  });

  it("handles doubled-quote escapes inside strings", () => {
    const sql = "INSERT INTO t VALUES ('it''s fine; really'); SELECT 1;";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('it''s fine; really')",
      "SELECT 1",
    ]);
  });

  it("does not split inside dollar-quoted strings with arbitrary tags", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN RAISE NOTICE 'a; b'; END $body$;\nSELECT 2;";
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("$body$");
    expect(parts[0]).toContain("a; b");
    expect(parts[1]).toBe("SELECT 2");
  });

  it("does not split inside the empty-tag dollar-quoted form", () => {
    const sql = "DO $$ BEGIN RAISE NOTICE 'x; y'; END $$;\nSELECT 3;";
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("$$");
    expect(parts[1]).toBe("SELECT 3");
  });

  it("strips line comments outside strings but leaves '--' inside strings intact", () => {
    const sql =
      "-- header comment\nSELECT 1; -- trailing comment\nINSERT INTO t VALUES ('-- not a comment');";
    expect(splitSqlStatements(sql)).toEqual([
      "SELECT 1",
      "INSERT INTO t VALUES ('-- not a comment')",
    ]);
  });

  it("strips block comments outside strings", () => {
    const sql = "/* leading */ SELECT 1; /* mid */ SELECT 2 /* trailing */;";
    expect(splitSqlStatements(sql)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("treats an unterminated single-quoted string as a single statement", () => {
    // Garbage in → garbage out, but never throw — the caller decides.
    const sql = "SELECT 'unterminated; really";
    expect(splitSqlStatements(sql)).toEqual(["SELECT 'unterminated; really"]);
  });
});
