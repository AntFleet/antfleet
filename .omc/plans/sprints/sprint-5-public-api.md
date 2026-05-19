# Sprint 5 — Public JSON API

> Invariants from `.omc/plans/antfleet-runbook.md §1` apply.

## Goal

Expose AntFleet's code-quality data layer as a stable, paginated, public JSON API. Downstream consumers (third-party dashboards, ecosystem watchers, agent-operator tooling, eventual Liquid Dune dashboards) become *downstream of our data layer*. Owning the canonical data shape is the long-term moat.

## Re-check gate

- [ ] Data shape stable: no schema changes to `agent_findings` for ≥2 weeks.
- [ ] ≥30 receipts in corpus (otherwise API serves an empty room and consumers don't bother).

## Preconditions

1. Sprints 1-4 shipped.
2. `agent_findings`, `factory_launches`, `roast_submissions`, `agent_claims` schemas all stable for 2+ weeks.
3. `pnpm -F @antfleet/web typecheck && test && build` green.

## Design constraint

Public API = public contract. Once a downstream tool consumes a field, breaking it is expensive. Therefore: **be conservative in what we expose.**

- Expose: published, terminal-state data only.
- Do not expose: internal state machines, IP hashes, raw submitter emails, claim signatures.
- Version from day one: `/api/v1/...`.
- Document the contract; consumers will assume "if it's documented, it's stable."

## Deliverables

### 1. [CLAUDE] API design doc

Write `.omc/plans/sprints/sprint-5-api-contract.md` BEFORE any code. Includes:
- Endpoint list with method, path, params.
- Response schemas (JSON Schema or TypeScript types).
- Pagination model (cursor-based, not offset).
- Rate limit policy.
- Versioning policy (breaking changes → `/api/v2/`, never modify v1).
- Error response shape.

Minimum endpoints to design:
- `GET /api/v1/findings` — list, filterable by `agent_token_address`, `repo_full_name`, `severity`, `since`.
- `GET /api/v1/findings/:findingId` — detail.
- `GET /api/v1/agents` — list (merged hardcoded registry + `factory_launches`).
- `GET /api/v1/agents/:address` — detail (metadata + receipts summary).
- `GET /api/v1/agents/:address/findings` — agent-specific findings.
- `GET /api/v1/agents/:address/drift` — drift snapshots.
- `GET /api/v1/stats` — aggregate counts.

Claude owns — judgment call about what's safe to expose.

### 2. [CODEX] Endpoint implementation

Spec (after design doc complete):

```
Implement the endpoints defined in sprint-5-api-contract.md under
apps/web/app/api/v1/.

Conventions:
  - All responses JSON; Content-Type: application/json
  - Cursor pagination: ?limit=<int>&cursor=<opaque-base64>
  - Default limit: 20, max: 100
  - Return shape: { data: [...], next_cursor: <string|null> }
  - Errors: { error: { code: <string>, message: <string> } } with
    appropriate HTTP status
  - Cache-Control: public, s-maxage=60 on lists; s-maxage=300 on
    detail; no-store on /stats

Tests: one happy + one error path per endpoint. Verify pagination
round-trips with no duplicates across pages.

Output to .omc/codex-out/02-endpoints/.
```

[CLAUDE-REVIEWS-CODEX] Spot-check serialization (no internal fields leak), cursor correctness, error shapes.

### 3. [CODEX] Rate limiting

Spec:

```
Apply rate limit to all /api/v1/* routes: 60 requests per minute per IP.
Reuse the existing rate-limit pattern from /api/roast (grep for it).
ip_hash uses the same daily-rotating salt pattern.

429 response includes Retry-After header.

Tests: 60 succeed, 61st returns 429.

Output to .omc/codex-out/03-ratelimit/.
```

[CLAUDE-REVIEWS-CODEX] Same pattern as `/api/roast`, no new infrastructure.

### 4. [CODEX] OpenAPI spec

Spec:

```
Generate apps/web/public/api/v1/openapi.json — OpenAPI 3.1 spec matching
the contract in sprint-5-api-contract.md. Served as a static file.

Optionally: generate TypeScript client at apps/web/lib/api-client/ via
openapi-typescript — only if already in package.json or trivially
addable; otherwise skip.

Output to .omc/codex-out/04-openapi/.
```

[CLAUDE-REVIEWS-CODEX] Validate OpenAPI spec via swagger CLI; ensure matches actual endpoint behavior.

### 5. [CLAUDE] Public docs page

`apps/web/app/api/page.tsx`. Plain documentation:
- What the API is.
- Link to `/api/v1/openapi.json`.
- Curl examples for each endpoint.
- Rate limit policy.
- Versioning policy ("v1 is stable; breaking changes go to v2").
- "How to cite AntFleet data" guide.

Claude writes the copy — brand-sensitive.

### 6. [CLAUDE] Tweet draft for API launch

`post-drafts.ts` extension. One-shot on first deploy:

```
TODO(voice)

antfleet's code-quality data is now a public API
agents, findings, drift, stats — all paginated, all versioned
antfleet.dev/api
openapi spec: antfleet.dev/api/v1/openapi.json
```

## Out of scope (sprint-specific)

- Auth / API keys (60 req/min anonymous is plenty).
- POST / write endpoints.
- Webhooks (Sprint 6).
- GraphQL.
- Rate-limit bypass for partners.

## Verification

- `pnpm -F @antfleet/web typecheck && test && build` green.
- `vercel ls --prod` READY after push.
- Every endpoint returns documented response shape for happy + error paths.
- OpenAPI spec validates against swagger-cli.
- Pagination: walk all `/api/v1/findings` pages, sum counts, matches `SELECT count(*) FROM agent_findings` from the same instant.
- Internal fields confirmed absent (`ip_hash`, `submitter_email`, `claimer_signature`, mid-transition statuses).
- 61st request from same IP in a minute → 429.
- Cache-Control headers correct.
- `/api` docs page in a real browser.

## Stop conditions

- All deliverables verified → done.
- Contract review reveals fields that shouldn't be public → STOP, redesign before coding.
- Pagination bugs (duplicates or missing rows across pages) → STOP, fix before shipping.
- Production deploy fails → stop, surface logs.

## On completion

Update `.omc/plans/antfleet-runbook.md`:
1. Mark Sprint 5 ✅ DONE with merged PR; move ▶ NEXT to Sprint 6.
2. Append to §1 "Active surface":
   - Routes: `/api/v1/findings`, `/api/v1/findings/:id`, `/api/v1/agents`, `/api/v1/agents/:address`, `/api/v1/agents/:address/findings`, `/api/v1/agents/:address/drift`, `/api/v1/stats`, `/api` docs, `/api/v1/openapi.json`
   - Libraries: `apps/web/lib/api-client/` (if shipped)
3. List under "Shipped:" in Sprint 5 entry.
4. Commit runbook update in the same PR.
