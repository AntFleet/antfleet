# SARIF ingest/export E2E report

Generated: 2026-06-24T03:54:33.070Z

## Fixture ingest

| Batch | Tool | Total | Real | False positive | Inconclusive | Errors | Notes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| codeql-fixture | CodeQL | 1 | 0 | 0 | 1 | 0 | Parsed CodeQL dialect; live reachability/patch gates not fired without bench DB migration. |
| snyk-fixture | Snyk Code | 1 | 0 | 0 | 1 | 0 | Parsed Snyk dialect; live reachability/patch gates not fired without bench DB migration. |

## Export validation

- OASIS/GitHub structural validator: pass
- Validation errors: none
- Exported results: 1

## Code Scanning push

- Not executed in this local session. The visible AntFleet bench repos are public, while the requested render check calls for a private bench repo.
- `codeql` and `snyk` CLIs were not installed locally, so fresh local scanner generation could not run without adding external tools.
- A deliberately invalid upload probe reached GitHub's Code Scanning upload validator and failed with HTTP 422 before ingestion, confirming the endpoint path but not rendering.
- v1 path remains the customer-owned workflow in `apps/web/public/integrations/codescanning.yml`.

## Dialect coverage gaps

- Checkmarx, Veracode, and Fortify intentionally deferred to v2.
- v1 preserves unknown SARIF properties on each claim but only normalizes severity/rule/location/message fields required by AntFleet gates.
