# SPEC-001 x402 Implementation Notes

## Design Decisions

- 2026-05-29: Keep `reviewPR()` unchanged. Rail-aware behavior is confined to the x402 route, x402 support modules, and the `review_jobs` dispatcher.
- 2026-05-29: Pin `@x402/core`, `@x402/express`, and `@x402/evm` to `2.13.0`, verified with `npm view` against the npm registry.
- 2026-05-29: Store verified x402 authorization, authorization window, review linkage, and settlement state in explicit `review_jobs.x402_*` columns. `result` is reserved for the public terminal API payload only.

## Deviations

- 2026-05-29: The migration apply script is placed at `apps/web/db/migrations/apply-migration-0028.ts` per SPEC-001 §5.5.2. Existing older scripts live under `apps/web/scripts/`; this follows the locked spec path.
- 2026-05-29: Migration 0028 intentionally expands beyond the original three-column sketch so deferred settlement can be audited without overloading `review_jobs.result`.

## Tradeoffs

- 2026-05-29: Use explicit facilitator `/verify` and `/settle` calls rather than auto-settling middleware. This preserves deferred settlement and keeps settlement decisions observable in the worker.

## Open Questions

- OQ-1: Confirm aeon runtime can distribute and rotate `AEON_GATE_SECRETS`.
- OQ-2: Ship 10 successful reviews per wallet per hour unless the operator revises.
- OQ-3: Ship 10-minute per-repo cooldown unless the operator revises.
- OQ-5: Production CDP API keys and facilitator quota remain required before mainnet AC-1.
- External fixture repo `antfleet/x402-fixture`, `antfleet/aeon-skills` PR, and `aaronjmars/aeon` registry PR were not created from this Codex App session. They require GitHub credentials/authority and are left as operator-executed steps.

## v2 Candidates

- Public non-aeon access after v1 usage and abuse metrics are understood.
- Live inference cost streaming and mid-flight abort once provider clients expose the required signals.
- Private repo support remains GitHub App-only in v1.
