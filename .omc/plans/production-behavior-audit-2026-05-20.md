# AntFleet production behavior audit — 2026-05-20

Scope: public production behavior at `https://www.antfleet.dev` after
`5348cd2f48fa5e461286b39ea368c5911cd19238` deployed.

## Production Evidence

- Latest Vercel production deployment inspected:
  `dpl_9soFHfmyVAAPH4cnfxZHdXaevpda`, status `Ready`, aliased to
  `https://www.antfleet.dev`.
- Public pages probed successfully with security headers:
  `/`, `/agents`, `/receipts`, `/roast`, `/api`, `/changelog`.
- `/roasts` returns `307` with `Location: /roast`, matching the unified
  roast page contract.
- `/api/health` returns only `{ "ok": true }`.
- Unauthenticated cron probes for `/api/cron/roast` and
  `/api/cron/poll-factory` return `401 unauthorized`.
- API v1 CORS/security/cache behavior was verified on success, error,
  OPTIONS, and rate-limit paths.
- API v1 rate limit began returning `429` after the documented threshold and
  included `Retry-After`.

## Finding Fixed

- `/agents` showed three findings-backed agents, but `/api/v1/agents` returned
  only the hardcoded registry agent, and `/api/v1/agents/<aeon>` returned
  `404` despite the public agent page returning `200`.
- Root cause: API v1 treated only registry and published factory-launch rows
  as addressable agents, while the public UI treats every non-`roast:`
  `agent_findings` address as an agent.
- Fix: API v1 agent list, detail, scoped findings, and stats now include
  findings-backed agents while preserving the existing response schema.

## Verification

- `git diff --check`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` — 185 passed, 8 skipped
- `pnpm --filter @antfleet/web test` — 383 passed
- `pnpm --filter @antfleet/web build`
- `pnpm --filter @antfleet/web typecheck`

## Remaining Boundaries

- Production DB was read only through public HTTP behavior; no privileged DB
  queries were run.
- Authenticated cron execution and Vercel function logs were not exercised.
