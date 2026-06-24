import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSarif } from "./sarif-parser";

const fixtureDir = join(process.cwd(), "test/fixtures/sarif");

describe("parseSarif", () => {
  it("parses CodeQL security severity and CWE metadata", () => {
    const parsed = parseSarif(readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"));
    expect(parsed.sourceTool).toBe("codeql");
    expect(parsed.sourceRevision).toBe("1111111111111111111111111111111111111111");
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "js/sql-injection",
      severity: "high",
      artifactUri: "src/routes/search.ts",
      startLine: 42,
      cwe: ["CWE-089"],
    });
  });

  it("parses Snyk severity from dialect properties", () => {
    const parsed = parseSarif(readFileSync(join(fixtureDir, "snyk.sarif"), "utf8"));
    expect(parsed.sourceTool).toBe("snyk");
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "javascript/NoSQLInjection",
      severity: "high",
      artifactUri: "api/users.js",
      startLine: 17,
      cwe: ["CWE-943"],
    });
  });

  it("parses Semgrep SARIF shape", () => {
    const parsed = parseSarif(readFileSync(join(fixtureDir, "semgrep.sarif"), "utf8"));
    expect(parsed.sourceTool).toBe("semgrep");
    expect(parsed.findings[0]).toMatchObject({
      ruleId: "regex-initialization",
      severity: "low",
      artifactUri: "StringExtensions.cs",
      startLine: 8,
    });
  });

  it("rejects unsupported SARIF versions", () => {
    expect(() => parseSarif({ version: "2.0.0", runs: [] })).toThrow(/2.1.0/);
  });
});
