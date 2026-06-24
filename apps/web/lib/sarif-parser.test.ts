import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSarif } from "./sarif-parser";
import {
  MAX_SARIF_FINDINGS_PER_BATCH,
  MAX_SARIF_PATH_BYTES,
  MAX_SARIF_RESULTS_PER_RUN,
  MAX_SARIF_RUNS,
  MAX_SARIF_TEXT_FIELD_BYTES,
  SarifLimitError,
} from "./sarif-types";

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

  it("rejects too many runs", () => {
    expect(() =>
      parseSarif(sarif({ runs: Array.from({ length: MAX_SARIF_RUNS + 1 }, run) })),
    ).toThrow(SarifLimitError);
  });

  it("rejects too many results in one run", () => {
    expect(() =>
      parseSarif(
        sarif({
          runs: [run({ results: Array.from({ length: MAX_SARIF_RESULTS_PER_RUN + 1 }, result) })],
        }),
      ),
    ).toThrow(SarifLimitError);
  });

  it("rejects too many findings across runs", () => {
    const runs = Array.from({ length: MAX_SARIF_RUNS }, () =>
      run({ results: Array.from({ length: MAX_SARIF_RESULTS_PER_RUN }, result) }),
    );
    expect(() => parseSarif(sarif({ runs }))).toThrow(/MAX_SARIF_FINDINGS_PER_BATCH/u);
    expect(MAX_SARIF_RUNS * MAX_SARIF_RESULTS_PER_RUN).toBeGreaterThan(
      MAX_SARIF_FINDINGS_PER_BATCH,
    );
  });

  it("rejects oversized message, snippet, and path fields", () => {
    const longText = "a".repeat(MAX_SARIF_TEXT_FIELD_BYTES + 1);
    const longPath = "p".repeat(MAX_SARIF_PATH_BYTES + 1);
    expect(() =>
      parseSarif(sarif({ runs: [run({ results: [result({ message: { text: longText } })] })] })),
    ).toThrow(/MAX_SARIF_TEXT_FIELD_BYTES/u);
    expect(() =>
      parseSarif(sarif({ runs: [run({ results: [result({ snippet: longText })] })] })),
    ).toThrow(/MAX_SARIF_TEXT_FIELD_BYTES/u);
    expect(() =>
      parseSarif(sarif({ runs: [run({ results: [result({ artifactUri: longPath })] })] })),
    ).toThrow(/MAX_SARIF_PATH_BYTES/u);
  });
});

function sarif(overrides: { runs?: unknown[] } = {}): Record<string, unknown> {
  return { version: "2.1.0", runs: overrides.runs ?? [run()] };
}

function run(overrides: { results?: unknown[] } = {}): Record<string, unknown> {
  return {
    tool: { driver: { name: "CodeQL", rules: [] } },
    results: overrides.results ?? [result()],
  };
}

function result(
  overrides: { message?: unknown; artifactUri?: string; snippet?: string } = {},
): Record<string, unknown> {
  return {
    ruleId: "rule",
    message: overrides.message ?? { text: "message" },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: overrides.artifactUri ?? "src/app.ts" },
          region: {
            startLine: 1,
            snippet: { text: overrides.snippet ?? "const x = 1;" },
          },
        },
      },
    ],
  };
}
