# AntFleet Sprint Runbook

Single source of truth for sprint sequencing, conventions, and the deferred
list. Read this before drafting any prompt. Update it in the same commit as
any convention change.

Owner: augstar
Updated: 2026-05-19

---

## 1. INVARIANTS — never re-state in sprint prompts

### Identity & authorship

- All git writes use the `antfleet-ops` GitHub account.
  - Run `gh auth switch --user antfleet-ops` before any push.
  - Commit author: `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>`
- Branch hygiene:
  - `git fetch origin main` before any sprint.
  - Rebase if diverged. On conflict: `rebase --abort`, stash, branch off `origin/main`, stash pop.
  - Never force-push; never `reset --hard` without explicit user approval.

### Conventions

- Route param for agent pages: `[address]`.
- Table-name prefix: `agent_*`, `drift_*`, `roast_*`, `factory_*`.
- Schema migrations via drizzle-kit (current: through `0011_roast_submissions.sql`). Never hand-edit a landed migration.
- No new npm deps unless `package.json` shows nothing usable — grep first.
- No comments except where WHY is non-obvious; never narrate WHAT.
- No README files for new routes.
- No backwards-compat shims or dead-code rename markers.
- After every push: verify `vercel ls --prod` returns READY.
- Open every new route in a real browser before declaring done.

### Voice & brand

- AntFleet ≠ AntFeed. Never apply Colony Scout voice or @AntFeed channel to AntFleet.
- Tweet drafts → `.omc/state/posts/<ts>-<slug>.md` with `TODO(voice)` header.
- No auto-posting. Drafts await human approval.

### Delegation policy (Codex via OMC tmux)

- Orchestrator: Claude. Mechanical chunks → Codex via `omc-teams` tmux panes.
- Codex outputs to `.omc/codex-out/<deliverable>/`. Claude reviews, integrates, commits.
- Codex never commits. Codex never pushes.
- Per-deliverable annotation in sprint specs: `[CODEX]`, `[CLAUDE]`, `[CLAUDE-REVIEWS-CODEX]`.
- Spec blocks for Codex go verbatim into the tmux pane.
- Default split: schemas, intake endpoints, forms, generators, tests → Codex. Integration with existing pipelines, voice-sensitive content, architectural calls → Claude.

#### Codex liveness — non-negotiable

Claude is the orchestrator, not a silent fallback. Codex must actually be running for `[CODEX]` chunks.

- Before launching `omc team`, set `OMC_SHELL_READY_TIMEOUT_MS=90000` (default 30s is too short for codex CLI cold-start on Intel/Rosetta tmux — observed sprint 3).
- After launch, verify dispatch within 60s: `omc team status <name>` must transition from `phase=planning` to `phase=executing` with `tasks: in_progress≥1`. If it stays in `phase=planning` with the task still `pending`, dispatch has failed.
- If dispatch fails on a chunk: retry **once** with a fresh team (after `omc team shutdown` + `omc team api orphan-cleanup`). Codex tmux orchestration is brittle on this host — one retry is the budget.
- If the retry also fails: **STOP and surface to operator** — quote the failure reason (timeout, missing dependency, leader-pane empty, etc.). Do **not** silently switch to Claude-inline. Do **not** drop the chunk after N tries and proceed.
- The operator decides: fix the omc-teams plumbing, authorize a Claude-inline override for the specific chunk, or defer the sprint.
- If the operator authorizes Claude-inline override, note in the PR body: `Codex dispatch failed (<reason>); operator-authorized Claude-inline override on chunks: <list>`.

### Active surface (current — verified on main 2026-05-19)

Routes:

- `/agents`, `/agents/[address]`, `/agents/[address]/constitution`, `/agents/[address]/drift`
- `/agents/[address]/claim`, `/api/claim` (Sprint 4 — operator portal for repo attribution via EIP-191 signature)
- `/badge/[owner]/[repo].svg`
- `/roast`, `/api/roast`, `/roasts/[id]`
- `/api/cron/curate-weekly` (Sprint 5 follow-up — Monday 00:00 UTC)
- `/api/cron/poll-factory` (Sprint 3 — route present; **dormant**, no schedule. Activates when `AGENTS_FACTORY_ADDRESS` env is set on prod, i.e. once an agents-specific Liquid factory contract deploys)
- `/api/cron/run-prelaunch` (Sprint 3 — route present; **dormant**, no schedule. Reactivates alongside poll-factory)
- `/` (homepage — Sprint 4 added the "Receipt of the week" card above-fold when a `weekly_features` row exists for the current ISO week)
- `/receipts`, `/benchmarks` (pre-existing — do not modify)
- `/api/cron/*`, `/api/github/*`, `/api/opt-in/*` (pre-existing)
- `/api` (Sprint 5 — human-readable docs page for the public JSON API)
- `/api/v1/findings`, `/api/v1/findings/[finding_id]`, `/api/v1/agents`, `/api/v1/agents/[address]`, `/api/v1/agents/[address]/findings`, `/api/v1/agents/[address]/drift`, `/api/v1/stats` (Sprint 5 — public JSON API, cursor-paginated, 60 req/60s/IP rate limit applied in middleware)
- Static asset `/api/v1/openapi.json` (Sprint 5 — OpenAPI 3.1 spec served from `apps/web/public/api/v1/`)

Tables (apps/web/db/schema.ts):

- `agent_findings` — curated AntFleet findings
- `drift_snapshots` — per-commit drift timeseries
- `roast_submissions` — public roast intake + state machine (Sprint 3: `source` column distinguishes `public` vs `factory_watcher`; Sprint 4 moderation pipeline: status now `awaiting_approval | queued | running | published | rejected | failed`)
- `factory_launches` — Liquid factory TokenCreated index (Sprint 3)
- `cron_cursors` — generic key-value cursors for cron scripts (Sprint 3)
- `agent_claims` — Sprint 4 operator signature attestations (FK-by-convention to `factory_launches.token_address`)
- `weekly_features` — Sprint 4 receipt-of-the-week curation (PK `week_start`)
- `outgoing_prs` — cross-repo PR linkage
- (plus webhook/cron tables from earlier sprints)

Migrations through: `0015_agent_claims_unique_indexes.sql`

Libraries:

- `apps/web/lib/api-v1/cursor.ts` — Sprint 5 base64url JSON cursor encode/decode
- `apps/web/lib/api-v1/responses.ts` — Sprint 5 `jsonOk` / `jsonError` / `jsonStats` / `optionsResponse` helpers with the cache + CORS headers from the contract
- `apps/web/lib/api-v1/serialize.ts` — Sprint 5 explicit-key serializers (redaction enforced here — never splat DB rows into JSON)
- `apps/web/lib/api-v1/rate-limit.ts` — Sprint 5 in-memory sliding window keyed by sha256(ip + ROAST_IP_SALT); 60 req/60s; `checkRateLimit(ip)` callable from middleware
- `apps/web/lib/claim-message.ts` — Sprint 4 EIP-191 message format (`buildClaimMessage`, `parseClaimMessage`)
- `apps/web/lib/identity-drift.ts`
- `apps/web/lib/post-drafts.ts` — tweet draft pipeline (Sprint 3 factory drafts + Sprint 4 `writeClaimVerifiedDraft`, `writeWeeklyFeatureDraft`)
- `apps/web/lib/prelaunch-dispatcher.ts` — Sprint 3 state-machine driver
- `apps/web/lib/repo-discovery.ts` — Sprint 3 tokenURI + github_search heuristic
- `apps/web/lib/roast-intake.ts`
- `apps/web/lib/roast-runner.ts`
- `apps/web/lib/roast-status.ts` — Sprint 4 `ROAST_STATUSES` source of truth
- `apps/web/scripts/backfill-factory.ts` — Sprint 3 historical one-shot
- `apps/web/scripts/curate-weekly.ts` — Sprint 4 auto-curator (Monday 00:00 UTC)
- `apps/web/scripts/feature-finding.ts` — Sprint 4 manual operator weekly-feature override
- `apps/web/scripts/poll-factory.ts` — Sprint 3 factory event poller
- `apps/web/scripts/roast-moderate.ts` — Sprint 4 moderation CLI (list/promote/reject)
- `apps/web/scripts/run-prelaunch.ts` — Sprint 3 dispatcher CLI
- `apps/web/scripts/run-roast.ts`
- `apps/web/scripts/publish-feelocker-finding.ts`
- `apps/web/scripts/verify-openapi.ts` — Sprint 5 OpenAPI structural check (run from repo root via `pnpm exec tsx apps/web/scripts/verify-openapi.ts`)

Existing infra to reuse, not re-build:

- Webhook + retry cron (commit `4b9cc39`)
- Benchmark pipeline (invoked from `run-roast.ts`)
- Existing form components and styles — grep before rolling your own.

---

## 2. STRATEGIC FRAME

### Constraint

AntFleet is the **code-quality data layer** for launchpad agents. Nothing else.

Not in scope, ever:

- Launchpad explorer (mcap, volume, vault state) — Liquid + Dune cover this.
- Trading interface for $FLEET or any token.
- Wallet.
- Generic Dune-competing dashboard.
- Anything that doesn't pivot on code quality or agent identity integrity.

### Coupling discipline

- Decouple AntFleet's attention engine from Liquid's launchpad timeline where possible.
- Factory watcher (Sprint 3) is the latent bridge — silent until Liquid drives launches, then auto-activates.
- Until launchpad goes live, depth + roast are the attention surface (both work on N=1).

### Posting cadence

Every shipped feature defines what gets drafted when its events fire. Wire posts into `.omc/state/posts/` from the same pipeline that produces the data. The attention layer is not free — it must be wired into the data layer.

---

## 3. SPRINT SEQUENCE

Each sprint has a re-check gate. If the gate fails, do not execute — re-sequence or update the runbook first.

### Sprint 1 — Depth track ✅ DONE (PR #16)

**Shipped:** `/agents/[address]`, `/agents`, `/badge/[owner]/[repo].svg`, constitution inspector, drift monitor, `agent_findings` + `drift_snapshots` tables, `agent-registry`, `post-drafts` pipeline.

### Sprint 2 — Roast engine ✅ DONE (PR #18)

**Shipped:** `/roast`, `/api/roast`, `/roasts/[id]`, `roast_submissions` table, runner (`run-roast.ts`), rate limiting, OG tags.

### Sprint 3 — Factory watcher + pre-launch health check ✅ DONE (dormant)

**Shipped:** `factory_launches` + `cron_cursors` tables (migration `0012_factory_launches.sql`), `roast_submissions.source` column, `poll-factory.ts` + `/api/cron/poll-factory`, `backfill-factory.ts` one-shot, `repo-discovery.ts` (tokenURI + github_search), `prelaunch-dispatcher.ts` + `/api/cron/run-prelaunch`, `run-prelaunch.ts` CLI, auto-stub `/agents/[address]` page (direct-URL only), three factory tweet-draft helpers in `post-drafts.ts`.

**Codex orchestration note:** CODEX-1 (schema) executed Claude-inline after omc-teams dispatch failed twice (operator-authorized retroactively after omc-teams root cause was fixed). CODEX-2/3/5 executed via real `omc team 1:codex` with `OMC_SHELL_READY_TIMEOUT_MS=90000` (the fix from PR upstream).

**Post-merge correction (2026-05-19):** the initial implementation hardcoded `0x04F1a284…77760` as the factory address, which turned out to be the general Liquid Protocol token factory (powering `app.liquidprotocol.org/tokens` — memecoins + the autonomopoly bootstrap deploy). There is **no separate agents-specific factory contract yet**; the agents launchpad will launch later. The backfill caught 2,220 unrelated memecoin deploys before this was caught. Follow-up corrections:

- `FACTORY_ADDRESS` is now read from `process.env.AGENTS_FACTORY_ADDRESS`. If unset, the poller and backfill no-op with a clear log line.
- Both cron schedules removed from `vercel.json` — routes are still live for manual invocation but no automated polling.
- `factory_launches` table truncated on prod + dev; `poll-factory.*` cron cursors deleted.
- `/agents` index reverted to findings-only (the auto-stub `/agents/[address]` page remains live for direct URL hits — useful when the dispatcher reactivates).

**To reactivate** when the agents factory deploys: set `AGENTS_FACTORY_ADDRESS=0x…` in Vercel prod env, re-add the two cron schedules to `vercel.json`, optionally run `backfill-factory.ts` once.

### Sprint 4 — Operator portal + receipt-of-the-week ✅ DONE

**Shipped:** `agent_claims` + `weekly_features` tables (migrations `0013_agent_claims.sql`, `0014_weekly_features.sql`, `0015_agent_claims_unique_indexes.sql`); `/api/claim` POST with EIP-191 signature verification + transactional INSERT/UPDATE + unique-index race protection; `/agents/[address]/claim` page with wallet-sign flow; unclaimed banner on `/agents/[address]` for `repo_not_found` rows; `/agents?filter=unclaimed` filtered view + hero count; `lib/claim-message.ts` canonical message helper; `scripts/curate-weekly.ts` auto-curator (Monday 00:00 UTC ranking by severity → upstream PR → merged-sha → recency; cron wiring landed in Sprint 5 follow-up (PR TBD — Claude will fill in)); `scripts/feature-finding.ts` manual operator override; Receipt-of-the-week card on homepage above-fold; `writeClaimVerifiedDraft` + `writeWeeklyFeatureDraft` post-draft helpers.

**Gate-failure operator override:** Re-check gates both failed at start (0 `repo_not_found` rows since factory watcher dormant; only 1 `agent_findings` row). Operator authorized full execution as a forward investment — the operator portal becomes useful the moment an agents-specific factory contract deploys + reactivates the watcher, and the receipt-of-the-week surface activates as `agent_findings` grows.

**Codex orchestration:** CODEX-1/2/3/4/5/7 all dispatched via `omc team 1:codex` with `OMC_SHELL_READY_TIMEOUT_MS=90000`. CODEX-4 (security fixes on /api/claim) followed an explicit security-reviewer pass that ruled "block — requires fix" on HIGH (race + non-transactional INSERT/UPDATE) — addressed via DB unique indexes + transaction wrap + `isPublicRepo`-after-signature reordering + tighter clock-skew tolerance. CLAUDE-4/6/8 handled voice-sensitive UI copy, auto-curation logic, and tweet drafts per runbook §1 delegation policy.

### Sprint 5 — Public JSON API ✅ DONE

**Shipped:** Frozen public contract at `.omc/plans/sprints/sprint-5-api-contract.md`. Seven GET endpoints under `/api/v1/` (findings list/detail, agents list/detail, agent-scoped findings, agent-scoped drift, stats) with cursor-paginated lists `{ data, next_cursor }`, redaction-by-construction via `lib/api-v1/serialize.ts` (no `...row` splats — internal columns cannot leak), CORS `Access-Control-Allow-Origin: *` on 2xx, documented Cache-Control per route, address validation via `/^0x[a-fA-F0-9]{40}$/u`, and consistent `{ error: { code, message } }` shape on 4xx/5xx. Rate-limit applied in `middleware.ts` (60 req/60s/IP across all `/api/v1/*`, sliding window keyed by sha256(ip + ROAST_IP_SALT), 429 with `Retry-After`). OpenAPI 3.1 spec served as a static asset at `/api/v1/openapi.json` with a repo-root `verify-openapi.ts` script. Human-readable docs page at `/api`. Final test count: 360 passing.

**Re-check gate:** Gate 2 (≥30 receipts) passed at 69 public receipts on prod. Gate 1 (agent_findings schema stable ≥2 weeks) relaxed per handoff doc — the repo is younger than 2 weeks but the agent_findings column set has not changed since Sprint 1 (PR #16).

**Codex orchestration:** CODEX-2/3/4/5 all dispatched via `omc team 1:codex` with `OMC_SHELL_READY_TIMEOUT_MS=90000`. Chunk 04 first dispatch printed help text instead of starting the team (transient `omc` CLI hiccup); retried once with a shorter prompt and succeeded on the second attempt (within the runbook's 1-retry budget). CLAUDE wrote the contract design doc, voice-sensitive page copy embedded in chunk-05's TASK.md, and the runbook update. Chunk 06 (tweet draft) was skipped at operator request.

**Detail:** [`sprints/sprint-5-public-api.md`](sprints/sprint-5-public-api.md) · contract: [`sprints/sprint-5-api-contract.md`](sprints/sprint-5-api-contract.md)

### Sprint 6 — Breadth features (leaderboard, forks tracker, cross-agent catalog) ▶ NEXT

**Re-check gate:**

- [ ] N ≥ 5 distinct agents with at least one published finding each — verify: `SELECT COUNT(DISTINCT agent_token_address) FROM agent_findings WHERE agent_token_address NOT LIKE 'roast:%'` ≥ 5.
- [ ] ≥ 2 forks of `agent-autonomopoly` (or any base template) exist on chain.

**Detail:** [`sprints/sprint-6-breadth-features.md`](sprints/sprint-6-breadth-features.md)

---

## 4. DEFERRED / NEVER — explicit kill list

Do not propose, do not build, do not stub. Re-litigation requires updating this runbook first.

- Launchpad explorer (mcap, volume, vault state).
- Trading interface for any token, including $FLEET.
- Wallet of any kind.
- Generic Dune-competing dashboard.
- Auth / user accounts on roast submissions.
- Paid roasts.
- Email notifications to roast submitters.
- Cross-chain support (Base only).
- Auto-posting tweets (drafts only, forever).
- Letting Codex commit directly.
- Roasting private repos.
- Constitution diff UI before N≥2 agents.
- Leaderboard before N≥5 agents.
- Forks tracker before ≥2 forks exist.
- Cross-agent findings catalog before ≥10 reviewed agents.

---

## 5. EXECUTION COMMAND

Single command going forward:

```
/autopilot

Read .omc/plans/antfleet-runbook.md. Identify the next sprint marked ▶ NEXT.
Run its re-check gate. If any check fails, STOP and surface the failure to
the operator — do not execute.

If the gate passes, read the corresponding sprints/sprint-N-*.md file. That
file is your full prompt. Execute it under all invariants from runbook §1.
Apply delegation policy from §1.

When complete:
  1. Update runbook.md §3: mark the sprint ✅ DONE with the merged PR
     number, list what shipped under "Shipped:", move the ▶ NEXT marker.
  2. Append shipped routes/tables/libraries to §1 "Active surface".
  3. Commit the runbook update in the same PR as the sprint work.
```

---

## 6. MAINTENANCE

- Re-read this runbook every 2-3 weeks. The DEFERRED list and strategic frame rot fastest.
- Convention changes update §1 in the same commit as the code change. The runbook is a tested artifact, not a doc.
- If a sprint's re-check gate is vague or unfalsifiable, fix the gate before the sprint executes.
- If a strategic premise breaks (e.g. Liquid pivots away from agents-on-chain), STOP the runbook, escalate to operator.
