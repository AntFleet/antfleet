# Sprint 3 — Factory Watcher + Pre-launch Health Check

> Invariants and conventions from `.omc/plans/antfleet-runbook.md §1` apply.
> Branch hygiene, authorship, voice rules, and delegation policy are inherited.

## Goal

Convert every new Liquid Protocol agent launch into an AntFleet artifact:
an auto-stubbed `/agents/[address]` page within minutes, and (if the repo
is discoverable) a pre-launch benchmark verdict published inside the 24h
vault deposit window.

This sprint stays silent until Liquid's launchpad starts driving launches.
The moment a third-party agent deploys, AntFleet auto-generates a page and
(best case) a verdict — without operator intervention. That auto-stub +
verdict is itself a tweet.

## Re-check gate

- [ ] Liquid launchpad UI is still pre-public, OR has shipped and Sprint 6 leaderboard does NOT need to jump the queue.
- [ ] Sprint 2's `run-roast.ts` runner is in production with ≥1 successful publish.

## Preconditions

1. `gh auth status` shows `antfleet-ops`.
2. `agent_findings` + `roast_submissions` tables exist in production.
3. Benchmark pipeline invocable from a script (confirm by inspecting `scripts/run-roast.ts`).
4. Base RPC reachable:
   ```
   curl -sS -X POST https://mainnet.base.org \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
     | jq -r .result
   ```
   Expect `0x2105`.
5. Factory bytecode present at `0x04F1a284168743759BE6554f607a10CEBdB77760` (eth_getCode non-empty).
6. tmux + omc-teams operable.
7. `pnpm -F @antfleet/web typecheck && test && build` all green before changes.

## Deliverables

### 1. [CODEX] Schema for tracked launches

Spec for the worker (paste verbatim into pane):

```
Add a drizzle table `factory_launches` to apps/web/db/schema.ts:
  token_address text pk,
  deployer_address text not null,
  token_name text,
  token_symbol text,
  block_number bigint not null,
  tx_hash text not null,
  deployed_at timestamp not null,
  repo_full_name text,
  repo_discovered_at timestamp,
  repo_discovery_method text,
  prelaunch_status text not null default 'pending',
  prelaunch_finding_id text,
  observed_at timestamp default now().

Also add column to roast_submissions:
  source text not null default 'public'.

Generate drizzle migration (next number: 0012). Output ONLY to
.omc/codex-out/01-schema/. Do not modify the working tree. Do not commit.
```

`prelaunch_status`: `pending | benchmarking | published | repo_not_found | benchmark_failed`
`repo_discovery_method`: `token_uri | github_search | operator_submission`
`source`: `public | factory_watcher`

[CLAUDE-REVIEWS-CODEX] Diff schema, run migration in dev, verify.

### 2. [CODEX] Factory event poller

Spec:

```
Implement apps/web/scripts/poll-factory.ts using viem (already a dep —
grep package.json to confirm).

Read last_processed block from existing key-value store if one exists
(grep first). Else create `cron_cursors (key text pk, value text)` table.

Per invocation:
  a. fromBlock = max(last_processed, factory_deploy_block). Look up the
     factory_deploy_block via basescan for
     0x04F1a284168743759BE6554f607a10CEBdB77760. Hardcode as constant
     with a one-line comment naming the source.
  b. toBlock = currentBlock - 12 (12-block confirmation depth on Base).
  c. eth_getLogs for TokenCreated on the factory. Use ABI from
     Liquid-Protocol-Ops/liquid-protocol-v0 src/Liquid.sol. Hardcode
     the event topic hash with a comment.
  d. For each event: parse token_address, deployer_address, token_name,
     token_symbol, block_number, tx_hash, deployed_at.
     INSERT into factory_launches ON CONFLICT (token_address) DO NOTHING.
  e. Update last_processed = toBlock.

Errors: log + exit nonzero. Do NOT advance cursor on partial failure.
Tests: mock viem client, verify cursor advance + idempotency.

Output to .omc/codex-out/02-poller/.
```

[CLAUDE-REVIEWS-CODEX] Verify confirmation depth, idempotency, cursor handling. Wire as a Vercel cron under `/api/cron/poll-factory` (match the pattern in `apps/web/app/api/cron/`).

### 3. [CODEX] Backfill script

Spec:

```
Implement apps/web/scripts/backfill-factory.ts. One-shot: walk from
factory_deploy_block to currentBlock-12 in 2000-block chunks (Base log-
range limit), inserting all historical TokenCreated events. Idempotent.
Print progress every chunk. Output to .omc/codex-out/03-backfill/.
```

[CLAUDE-REVIEWS-CODEX] Run once manually. Expect 2-5 rows (Liquid-Protocol-Ops currently has agent-autonomopoly + agent-selffunded-agent-test as production agents).

### 4. [CLAUDE] Auto-stub /agents pages

Touches existing depth-track surface — Claude owns.

- Convert `apps/web/lib/agent-registry.ts` from hardcoded single-entry to async DB-backed lookup:
  - `getAgent(address)`: read hardcoded map first (autonomopoly stays canonical), fall through to `factory_launches`, return null if neither.
- `/agents/[address]` renders for any `factory_launches` row: token name, symbol, deployer, deploy date, repo (if discovered), pre-launch verdict (if published).
- `/agents` index lists all `factory_launches` rows sorted by `deployed_at` DESC.

### 5. [CODEX] Repo discovery heuristic

Spec:

```
Implement apps/web/lib/repo-discovery.ts with:
  discoverRepoForAgent(launch: FactoryLaunch): Promise<{
    repo: string | null,
    method: 'token_uri' | 'github_search' | null
  }>

Methods tried in order, stop on first success:
  a. token_uri: call tokenURI() on the token contract via viem. If
     return is IPFS/HTTPS JSON with `repository` or `repo` field
     naming github.com/<owner>/<repo>, use it. Verify the repo
     exists + is public via gh api repos/<owner>/<repo>.
  b. github_search: query gh api search/repositories with
     q='<token_symbol> liquid agent' AND q='<token_name> liquid'.
     Accept ONLY if exactly one public result mentions Liquid
     protocol OR has agent-shaped structure (identity.*.json,
     skills/, harness/ at root). Otherwise null.

Output to .omc/codex-out/05-discovery/. Include unit tests with mocked
gh + RPC clients.
```

[CLAUDE-REVIEWS-CODEX] Test against autonomopoly + selffunded — both must resolve. Verify github_search thresholds aren't loose; false-positive worse than miss.

### 6. [CLAUDE] Pre-launch benchmark dispatcher

`apps/web/scripts/run-prelaunch.ts`. Touches `run-roast.ts` state machine — Claude owns.

Logic:
- Poll `factory_launches WHERE prelaunch_status='pending' ORDER BY deployed_at ASC`.
- For each:
  1. If `repo_full_name` null: call `discoverRepoForAgent`. Success: persist repo + method + discovered_at. Null: set `prelaunch_status='repo_not_found'`, skip.
  2. Set `prelaunch_status='benchmarking'`.
  3. Insert `roast_submissions` row with `source='factory_watcher'`, `repo_full_name` set, `status=queued`.
  4. `run-roast.ts` picks it up. On its transition to `published`, this dispatcher detects via polling and sets `factory_launches.prelaunch_status='published'` + `prelaunch_finding_id`.
- 24h budget: if a launch has been `pending` > 24h without repo discovery → `repo_not_found`, move on.

Cron: every 10min (match existing cron pattern under `apps/web/app/api/cron/`). Idempotency: status-gated transitions.

### 7. [CLAUDE] Tweet drafts for factory events

Extend `apps/web/lib/post-drafts.ts`. On these transitions, write `.omc/state/posts/factory-<ts>-<symbol>.md`:

**a. New `factory_launches` row inserted:**
```
TODO(voice)

new liquid agent detected
<name> (<symbol>) at <address>
deployer: <deployer>
antfleet is looking for the repo →
```

**b. `repo_discovered_at` set, `prelaunch_status=benchmarking`:**
```
TODO(voice)

repo found for <symbol>: github.com/<repo>
antfleet is benchmarking inside the deposit window →
```

**c. `prelaunch_status=published`:**
```
TODO(voice)

pre-launch verdict for <symbol>: <N> consensus findings
top severity: <sev>
depositors deciding in the next 24h:
antfleet.dev/agents/<address>
```

Claude writes — voice-sensitive.

## Out of scope (sprint-specific)

- Websocket subscriptions (5min polling is sufficient).
- Operator portal for manual repo submission (Sprint 4).
- Trading / pricing data ingestion.
- Notifying operators their agent was auto-stubbed.

## Verification

- `pnpm -F @antfleet/web typecheck && test && build` green.
- `vercel ls --prod` READY after push.
- `factory_launches` populated by backfill — verify ≥1 row for autonomopoly's token (`0xB3D7498A10e78971AcDA096c833b34a5F7d2d8e`) with correct fields.
- `/agents` index lists `factory_launches` rows.
- `/agents/<autonomopoly-address>` still renders (regression check).
- Manual `poll-factory.ts` run: completes, advances cursor, no errors.
- `discoverRepoForAgent` resolves autonomopoly → `Liquid-Protocol-Ops/agent-autonomopoly`; obviously-wrong inputs return null.
- `run-prelaunch.ts` dry-run: pending rows transition correctly.
- Each tweet-draft path emits a file under `.omc/state/posts/`.
- Every new route opened in a real browser.

## Stop conditions

- All deliverables verified → done.
- Codex spec-non-compliance >2 retries on a chunk → Claude takes it over.
- Repo discovery has false positives in testing → tighten threshold before shipping.
- Auto-stub `/agents` page regresses autonomopoly's existing page → stop, debug.
- Production deploy fails → stop, surface logs.

## On completion

Update `.omc/plans/antfleet-runbook.md`:
1. Mark Sprint 3 ✅ DONE with the merged PR number; move ▶ NEXT to Sprint 4.
2. Append to §1 "Active surface":
   - Tables: `factory_launches`, `cron_cursors`
   - Libraries: `apps/web/lib/repo-discovery.ts`, `apps/web/scripts/poll-factory.ts`, `apps/web/scripts/backfill-factory.ts`, `apps/web/scripts/run-prelaunch.ts`
   - Cron endpoints: `/api/cron/poll-factory`, `/api/cron/run-prelaunch`
3. List under "Shipped:" in Sprint 3 entry.
4. Commit runbook update in the same PR as the sprint work.
