# Sprint 5 — Public JSON API contract (v1)

> Frozen contract for `/api/v1/*`. Once shipped, any breaking change ships under `/api/v2/`. Additive changes (new optional fields, new endpoints, new query params) are non-breaking and ship in-place.
>
> Owner: claude (this session). Implementers: codex (per runbook §1 delegation).

---

## 1. Scope

Read-only JSON surface over AntFleet's published code-quality data layer. Consumers in mind: third-party dashboards, Dune workspace authors, ecosystem watchers, agent operators automating their own surfaces, and AntFleet's own future tools.

### In scope

- `agent_findings` (hand-authored investigations)
- `drift_snapshots` (per-commit identity drift)
- Agents directory (hardcoded registry merged with published factory launches)
- Aggregate stats

### Out of scope (v1)

- `reviews` (the two-model consensus PR data — exposed today via `/receipts` HTML; JSON exposure deferred until column set stabilises post-Mission 7).
- `roast_submissions` (intake state machine — internal lifecycle, not a public contract).
- `factory_launches` (the watcher is dormant; the table is empty. Re-enable as additive v1 extension when populated).
- `agent_claims` (claim signatures are public verifiable artifacts but the API surface adds attacker reachability for no consumer demand yet).
- `weekly_features` (curation surface — embed it inside `/api/v1/stats` if asked, otherwise defer).
- Write endpoints; webhooks; GraphQL; auth/API keys; partner bypass.

### Hard redaction list

Never serialise these to the public API, ever:

- `roast_submissions.ip_hash`, `roast_submissions.submitter_email`
- `agent_claims.claimer_signature`, `agent_claims.claimer_address` (would expose pre-claim PII linkage if it ever ships)
- `reviews.repo_hash`, `reviews.installation_id`, `reviews.processing_*`
- `finding_status.*` mid-transition states (only terminal `closed | superseded` surface, and only via `/receipts` HTML)
- Any internal `created_at` timestamps that pre-date the `published_at` lifecycle stamp
- `factory_launches.deployer_address` if/when surfaced (the on-chain TX exposes it; the API need not amplify)

---

## 2. Conventions

### URL versioning

- `/api/v1/...` — this contract.
- `/api/v2/...` — reserved; first use is the first breaking change.
- v1 is frozen on first prod deploy. Field removals, type changes, semantic shifts → v2.

### Response envelope

All endpoints return JSON with `Content-Type: application/json; charset=utf-8`.

**List endpoints:**

```json
{
  "data": [ ... ],
  "next_cursor": "string|null"
}
```

`next_cursor` is `null` when the page is the last page. Otherwise the opaque value to pass as `?cursor=` for the next page.

**Detail endpoints:**

```json
{
  "data": { ... }
}
```

**Stats endpoint:** flat object, no envelope (it is a single aggregate object, not a resource).

```json
{ "total_findings": 1, "total_agents": 1, ... }
```

**Error responses** (all non-2xx):

```json
{
  "error": {
    "code": "snake_case_string",
    "message": "human-readable string"
  }
}
```

HTTP status drives the broad class; `code` is the stable identifier consumers should branch on.

### Cursor pagination

- Cursor is opaque base64url of an internal sort-key tuple. Consumers must treat it as a black box.
- Each list endpoint defines a stable secondary sort (usually the PK) to guarantee no duplicates and no skips across pages even when rows share the primary sort value.
- Query params: `?limit=<int>&cursor=<string>`. Default `limit=20`, max `limit=100`. Out-of-range → 400.
- A cursor that fails to decode → 400 (`invalid_cursor`). A cursor that decodes but points past the end → empty `data` + `next_cursor=null` (graceful).
- Ordering is fixed by the endpoint; consumers cannot pick a different sort in v1.

### Field naming

- Response keys are `snake_case` (matches DB column casing, low surprise for SQL consumers).
- ISO-8601 timestamps with UTC `Z` suffix for all datetime fields (`"2026-05-18T12:34:56.000Z"`).
- Addresses are returned in mixed-case (EIP-55 checksum) where known; otherwise the form stored in the table. Consumers should compare case-insensitively.

### Cache-Control

- List endpoints: `public, s-maxage=60, stale-while-revalidate=300`
- Detail endpoints: `public, s-maxage=300, stale-while-revalidate=3600`
- `/api/v1/stats`: `no-store` (real-time-ish aggregate)
- All error responses: `no-store`

### CORS

`Access-Control-Allow-Origin: *` on all 2xx responses. The data is already public; no credentials are involved. OPTIONS preflights return `Access-Control-Allow-Methods: GET, OPTIONS` and `Access-Control-Max-Age: 86400`.

### Rate limit

- 60 requests / 60 seconds / IP across all `/api/v1/*` combined.
- IP hashed via the existing `ROAST_IP_SALT` pattern (`sha256(ip + salt)`) so logs never carry raw IPs. Reuses the same env var to avoid a new deploy step.
- Implemented as an in-memory sliding window per warm function instance — Vercel may horizontally fan out and effectively raise the cap by `N * 60`, which is acceptable for a v1 anonymous public read API.
- 429 response includes `Retry-After: <seconds-until-window-clears>` header and body:
  ```json
  { "error": { "code": "rate_limited", "message": "max 60 requests per minute per ip" } }
  ```
- Rate-limit counters do **not** count `OPTIONS` preflights or 4xx parse errors against the consumer.

### Error code vocabulary (stable)

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_input` | Path or query param fails validation. `message` includes the offending field. |
| 400 | `invalid_cursor` | Cursor failed to decode. Consumer should drop the cursor and restart from page 1. |
| 404 | `not_found` | Resource id doesn't exist. |
| 429 | `rate_limited` | Per-IP window exceeded. |
| 500 | `internal` | Unhandled exception. `message` is generic; consumer should retry with backoff. |

Adding a new `code` for the same status is non-breaking. Removing or repurposing a code is breaking (v2).

---

## 3. Endpoints

### 3.1 `GET /api/v1/findings`

List of all `agent_findings` rows.

**Query params:**

| Name | Type | Notes |
|---|---|---|
| `agent_token_address` | string | EVM address. Compared case-insensitively. |
| `repo_full_name` | string | `owner/repo`. Compared case-insensitively. |
| `severity` | string | One of `info`, `low`, `med`, `high`. Invalid → 400. |
| `since` | ISO date | `published_at >= since`. Invalid → 400. |
| `limit` | int 1-100 | Default 20. |
| `cursor` | string | Opaque. |

**Sort:** `published_at DESC, finding_id ASC` (deterministic — `finding_id` is the PK and is unique).

**Item shape:**

```json
{
  "finding_id": "feelocker-selector-2026-05-18",
  "agent_token_address": "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e",
  "agent_name": "autonomopoly",
  "repo_full_name": "Liquid-Protocol-Ops/agent-autonomopoly",
  "title": "FeeLocker selector mismatch …",
  "severity": "high",
  "summary": "<markdown>",
  "evidence": "<markdown|null>",
  "upstream_pr_url": "https://github.com/…/pull/123|null",
  "upstream_merged_sha": "0xabc…|null",
  "published_at": "2026-05-18T12:34:56.000Z"
}
```

All columns from `agent_findings` surface 1:1. No redaction needed — this table is already designed as a public artefact.

**Example:**

```
GET /api/v1/findings?severity=high&limit=10
→ 200
{ "data": [ { "finding_id": "...", ... } ], "next_cursor": null }
```

### 3.2 `GET /api/v1/findings/:finding_id`

Single finding detail.

**Path param:** `finding_id` — exact match on `agent_findings.finding_id`.

**404:** `{ "error": { "code": "not_found", "message": "finding not found" } }`

**200 body:** `{ "data": <finding object as above> }`

### 3.3 `GET /api/v1/agents`

The agents directory.

For v1: a union of (a) the hardcoded registry (`lib/agent-registry.ts`) and (b) any `factory_launches` rows whose `prelaunch_status = 'published'`. The watcher is dormant and the table is empty today, so v1 effectively returns the registry only — the union keeps the contract stable when the watcher reactivates.

**Query params:** `limit`, `cursor` only. No filters in v1.

**Sort:** `first_seen_at DESC, address ASC`. For registry entries, `first_seen_at` is the project epoch (2026-05-19T00:00:00Z) — a stable sentinel so the autonomopoly entry sorts deterministically against future factory rows.

**Item shape:**

```json
{
  "address": "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e",
  "name": "autonomopoly",
  "repo_full_name": "Liquid-Protocol-Ops/agent-autonomopoly",
  "source": "registry",
  "first_seen_at": "2026-05-19T00:00:00.000Z",
  "findings_count": 1,
  "latest_finding_at": "2026-05-18T…|null"
}
```

`source` ∈ `"registry" | "factory"`. `findings_count` and `latest_finding_at` are joined from `agent_findings` so the listing is useful on its own (consumer can sort their own UI without a follow-up call per row).

### 3.4 `GET /api/v1/agents/:address`

Single agent detail.

**Path param:** `address` — EVM address. Compared case-insensitively. Not found → 404.

**200 body:** `{ "data": <agent object as 3.3, plus> }`:

```json
{
  "address": "0x…",
  "name": "...",
  "repo_full_name": "owner/repo",
  "source": "registry",
  "first_seen_at": "2026-05-19T00:00:00.000Z",
  "findings_count": 1,
  "latest_finding_at": "2026-05-18T…",
  "drift": {
    "snapshots_count": 0,
    "latest_observed_at": null,
    "latest_drift_score": null
  }
}
```

The `drift` sub-object summarises `drift_snapshots` for this agent. Each field can be `null` if no snapshots exist.

### 3.5 `GET /api/v1/agents/:address/findings`

Same shape as `/api/v1/findings` but filtered to one agent. Equivalent to `?agent_token_address=<address>` on `/findings`; provided for URL ergonomics and as a stable contract for "agent-scoped findings."

**Query params:** `severity`, `since`, `limit`, `cursor`. Same semantics as 3.1.

**404:** if no agent with that address exists (registry miss AND no factory_launches row), return 404 with `not_found`. Consumers should not infer "no findings yet" from a 404 here — they should check `/api/v1/agents/:address` first if uncertain.

### 3.6 `GET /api/v1/agents/:address/drift`

Drift snapshots for one agent.

**Query params:** `limit`, `cursor`, plus optional `since` (filters `commit_timestamp >= since`).

**Sort:** `commit_timestamp DESC, id ASC`.

**Item shape:**

```json
{
  "id": "0xabc…-0xdef…",
  "agent_token_address": "0x…",
  "commit_sha": "0xdef…",
  "commit_timestamp": "2026-05-15T…",
  "drift_score": "0.12",
  "threshold": "0.30",
  "observed_at": "2026-05-15T…"
}
```

`drift_score` and `threshold` are stringified `numeric` (preserves precision; consumers parseFloat).

**404:** same rule as 3.5 — agent must exist.

### 3.7 `GET /api/v1/stats`

Aggregate counts. No envelope, no cursor.

```json
{
  "total_findings": 1,
  "findings_by_severity": { "info": 0, "low": 0, "med": 0, "high": 1 },
  "total_agents": 1,
  "agents_with_findings": 1,
  "total_drift_snapshots": 0,
  "latest_finding_at": "2026-05-18T…",
  "generated_at": "<server time at response>"
}
```

`Cache-Control: no-store`. `generated_at` is the server timestamp at response time so consumers can detect staleness if they aggregate across multiple calls.

---

## 4. OpenAPI

A static OpenAPI 3.1 document is served at `/api/v1/openapi.json`. It is generated by hand (or by a thin script that round-trips the TypeScript types) and committed to `apps/web/public/api/v1/openapi.json`. The committed file is the source of truth — any drift between the OpenAPI doc and the runtime is a bug to fix in the same PR.

The spec must validate cleanly under `swagger-cli validate` (or an OpenAPI 3.1 validator of equivalent strictness).

---

## 5. Versioning policy

- v1 is frozen on first prod deploy. Field removals, type changes, semantic shifts → v2.
- Adding optional response fields, new endpoints, new query params, or new error `code` values within an existing status — all non-breaking, ship in-place.
- Renaming a field is breaking. Add the new name, deprecate the old name in OpenAPI, leave the old name responding until v2.
- Sort order of a list endpoint is part of the contract. Changing it is breaking.
- Default `limit` is part of the contract; raising it is non-breaking, lowering it is breaking.

---

## 6. Non-goals (called out so reviewers don't request them)

- No HATEOAS links. Consumers compose URLs from documented paths.
- No JSON:API compliance. The envelope is simpler and less work to consume from generic clients.
- No long-lived API tokens. Anonymous 60/min is plenty for the consumer set we have.
- No streaming / SSE / WebSocket. The data updates slowly enough that polling at 60/min is fine.
- No batch endpoints. v1 has one well-known list per resource type.

---

## 7. Acceptance for this contract (review checklist)

- [ ] Every column in the redaction list is not serialised by any handler.
- [ ] Every list endpoint returns `{ data, next_cursor }`.
- [ ] Every detail endpoint returns `{ data }`.
- [ ] Every error response matches the documented shape and status code.
- [ ] Cursor walk on `/findings` (with `limit=1`, then `limit=2`, then `limit=5`) returns the same set of `finding_id`s with no duplicates or omissions.
- [ ] Hitting 61 requests in 60s from one IP returns 429 with `Retry-After`.
- [ ] OpenAPI document validates and matches actual handler behaviour for a representative happy + error case per endpoint.
- [ ] Cache-Control headers match the table in §2.
- [ ] CORS `Access-Control-Allow-Origin: *` on 2xx.
