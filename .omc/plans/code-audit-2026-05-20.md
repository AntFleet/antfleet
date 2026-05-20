# AntFleet code audit closeout — 2026-05-20

Scope: last-three-day AntFleet sprint surface on `main` through
`8c78b27a61870a71640ea0bad2c48b149c1ed1cc`, plus local audit/refactor
changes made in this pass.

## Baseline

- Recent shipped surfaces reviewed: install approval gate, public API v1,
  X-attention OG/digest/share work, roast unification, agent benchmark
  cross-linking, durable review queue, and related runbook/docs updates.
- Local-only operator artifacts were present under `.omc/artifacts/`,
  `apps/web/.env.vercel-actual`, and `apps/web/scripts/_*.ts`. These are now
  ignored so product validation commands do not fail on scratch diagnostics.
- No tracked underscore-prefixed operator scripts or `.omc/artifacts` files
  existed before the ignore change.

## Changes Made

- Replaced the N+1 roast finding lookup in `loadPublishedRoasts()` with one
  batched lookup keyed by lowercased `roast:<submissionId>`, preserving the
  previous case-insensitive behavior.
- Extracted `summarizeRoastFindings()` and covered severity selection with
  focused tests.
- Migrated Next 16 request interception from `middleware.ts` / `middleware()`
  to `proxy.ts` / `proxy()`, following the official Next 16 rename.
- Removed the changelog route's repo-root runtime fallback so Turbopack no
  longer traces outside `apps/web`; the route reads the prebuild-copied
  `apps/web/CHANGELOG.md`.
- Updated README/runbook drift:
  - Migration head is `0017_agent_findings_bench_repo`.
  - `/roast` is the unified submission + published-roasts page.
  - API v1 rate limiting is applied in `proxy.ts`.

## Verification Evidence

- `git diff --check` passed.
- `pnpm format:check` passed.
- `pnpm lint` passed.
- `pnpm typecheck` passed.
- `pnpm test` passed: 185 passed, 8 skipped.
- `pnpm --filter @antfleet/web typecheck` passed.
- `pnpm --filter @antfleet/web test` passed: 383 passed.
- `pnpm exec tsx apps/web/scripts/verify-openapi.ts` passed.
- `pnpm --filter @antfleet/web build` passed with no Turbopack trace warning
  and no middleware deprecation warning.

## Residual Boundaries

- No production database or Vercel state was changed.
- Ignored local files are intentionally not formatted or audited as product
  code unless they are promoted into tracked scripts.
- The build output still labels the route layer as `Proxy (Middleware)`;
  that string is Next's own output, not a remaining app-level middleware
  reference.
