#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSarif } from "@/lib/sarif-parser";
import {
  findingsToSarif,
  validateSarifForGithub,
  type ExportableFinding,
} from "@/lib/sarif-export";

const root = process.cwd();
const fixtureDir = join(root, "test/fixtures/sarif");

function main() {
  const codeql = parseSarif(readFileSync(join(fixtureDir, "codeql.sarif"), "utf8"));
  const snyk = parseSarif(readFileSync(join(fixtureDir, "snyk.sarif"), "utf8"));
  const exportSarif = findingsToSarif({
    owner: "AntFleet",
    repo: "bench-sarif-export",
    findings: [fixtureFinding()],
  });
  const validation = validateSarifForGithub(exportSarif);

  const lines = [
    "# SARIF ingest/export E2E report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Fixture ingest",
    "",
    "| Batch | Tool | Total | Real | False positive | Inconclusive | Errors | Notes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    `| codeql-fixture | ${codeql.sourceToolName} | ${codeql.findings.length} | 0 | 0 | ${codeql.findings.length} | 0 | Parsed CodeQL dialect; live reachability/patch gates not fired without bench DB migration. |`,
    `| snyk-fixture | ${snyk.sourceToolName} | ${snyk.findings.length} | 0 | 0 | ${snyk.findings.length} | 0 | Parsed Snyk dialect; live reachability/patch gates not fired without bench DB migration. |`,
    "",
    "## Export validation",
    "",
    `- OASIS/GitHub structural validator: ${validation.length === 0 ? "pass" : "fail"}`,
    `- Validation errors: ${validation.length === 0 ? "none" : validation.join("; ")}`,
    `- Exported results: ${((exportSarif.runs[0] as { results?: unknown[] }).results ?? []).length}`,
    "",
    "## Code Scanning push",
    "",
    "- Not executed in this local session. The visible AntFleet bench repos are public, while the requested render check calls for a private bench repo.",
    "- `codeql` and `snyk` CLIs were not installed locally, so fresh local scanner generation could not run without adding external tools.",
    "- A deliberately invalid upload probe reached GitHub's Code Scanning upload validator and failed with HTTP 422 before ingestion, confirming the endpoint path but not rendering.",
    "- v1 path remains the customer-owned workflow in `apps/web/public/integrations/codescanning.yml`.",
    "",
    "## Dialect coverage gaps",
    "",
    "- Checkmarx, Veracode, and Fortify intentionally deferred to v2.",
    "- v1 preserves unknown SARIF properties on each claim but only normalizes severity/rule/location/message fields required by AntFleet gates.",
  ];
  const reportDir = join(root, "../../.omc/research");
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, "sarif-ingest-export-e2e.md"), `${lines.join("\n")}\n`);
}

function fixtureFinding(): ExportableFinding {
  return {
    findingId: "bench-sarif-001",
    title: "reachable scanner-backed vulnerability",
    severity: "high",
    category: "security",
    status: "closed",
    closureSha: "2222222222222222222222222222222222222222",
    patchAcceptedSha: "3333333333333333333333333333333333333333",
    reviewId: "review-sarif",
    owner: "AntFleet",
    repo: "bench-sarif-export",
    prNumber: 98,
    commitSha: "1111111111111111111111111111111111111111",
    evidenceBundle: {
      affectedSha: "1111111111111111111111111111111111111111",
      bundleStatus: "complete",
      pocSnippet: { value: { path: "src/routes/search.ts", line: 42 } },
      reproductionCommand: { value: "pnpm test -- search" },
      callPathTrace: {
        value: { path: "src/routes/search.ts", line: 42, callPath: ["GET /search", "db.query"] },
      },
    },
  };
}

main();
