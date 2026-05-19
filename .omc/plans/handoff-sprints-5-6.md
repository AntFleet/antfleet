# Handoff — pick up Sprints 5 and 6 in a new session

Updated: 2026-05-19 (immediately after PR #25 / Sprint 4 merged)

This document is the entry point for the next Claude session to execute Sprint 5 and (gates permitting) Sprint 6. Read this first, then the runbook, then the relevant sprint spec.

---

## TL;DR — what to do next

1. Open Sprint 5: `.omc/plans/sprints/sprint-5-public-api.md`. Read it end-to-end.
2. Run its re-check gates against prod (see §"Current prod state" below — Gate 2 is already met).
3. If gates pass, execute. Working contract: **Codex via `omc team 1:codex` for all coding tasks** (Sprint 4 used this end-to-end successfully).
4. Sprint 6 follows Sprint 5 in the runbook but is hard-gated on ≥5 distinct agents with findings — currently N=1, so Sprint 6 will block. Don't pre-execute it.

---

## Where we left off (state as of 2026-05-19 12:24 UTC)

### Last 6 PRs merged today

| PR | Commit | Subject |
|---|---|---|
| #20 | `e9ba7ce` | Sprint 3 — factory watcher + pre-launch dispatcher |
| #21 | `7741e23` | dormant factory watcher until agents launchpad ships |
| #22 | `3887ec2` | exclude roast: pseudo-keys from /agents queries |
| #23 | `2b93e48` | gate prelaunch dispatcher on AGENTS_FACTORY_ADDRESS + delete stale roast |
| #24 | `c8557cd` | roast moderation pipeline (all submissions gate behind operator) |
| #25 | `09ec131` | Sprint 4 — operator portal + receipt of the week |

Main is at `09ec131`. Vercel prod deploy from this commit should be Ready (verify: `vercel ls --prod`).

### Active surface on prod

Routes live (and routable via direct URL even when not advertised):
- `/agents`, `/agents/[address]`, `/agents/[address]/constitution`, `/agents/[address]/drift`
- `/agents/[address]/claim`, `/api/claim` — Sprint 4
- `/agents?filter=unclaimed` — filtered view
- `/badge/[owner]/[repo].svg`
- `/roast`, `/api/roast`, `/roasts/[id]`
- `/api/cron/poll-factory`, `/api/cron/run-prelaunch` — **dormant** (no cron schedule; env-gated on `AGENTS_FACTORY_ADDRESS`)
- `/` — homepage with `ReceiptOfTheWeekCard` (renders only when current week has a `weekly_features` row)
- All pre-existing routes from earlier sprints

Tables on prod through migration `0015_agent_claims_unique_indexes.sql`:
- `agent_findings`, `drift_snapshots`, `roast_submissions` (now with `source` + `awaiting_approval` lifecycle), `factory_launches` (empty), `cron_cursors` (empty), `agent_claims` (empty), `weekly_features` (empty), `outgoing_prs`, plus pre-existing review/findingStatus/maintainerReactions/onboardingEvents tables.

### Current prod data state (verified at handoff time)

- `agent_findings`: **1 row** (autonomopoly FeeLocker finding).
- `factory_launches`: **0 rows** (watcher dormant since PR #21).
- `roast_submissions`: 2 awaiting_approval rows + the autonomopoly historical row. The 2 awaiting_approval are the `digitalgoods221/motika` + `aguapotavel/sui-liquidity-sniper` rows from the dispatcher false-positive class — operator needs to **promote or reject** them via:
  ```bash
  cd apps/web
  DATABASE_URL=<prod> pnpm exec tsx scripts/roast-moderate.ts list
  DATABASE_URL=<prod> pnpm exec tsx scripts/roast-moderate.ts reject jmETWAoVdS0WgiE2MEezw --reason "factory_watcher false-positive — repo unrelated to token deployer" --apply
  DATABASE_URL=<prod> pnpm exec tsx scripts/roast-moderate.ts reject A6eb3Z7upAMS_ZKtvYjO- --reason "factory_watcher false-positive — repo unrelated to token deployer" --apply
  ```
- `reviews` (public_receipt=true): **69 rows** — this is what feeds Sprint 5 Gate 2.

### Local-dev setup that's already in place

- `apps/web/.env.local` → **dev Neon branch** (`ep-little-bird-aqq42imp-pooler.c-8.us-east-1.aws.neon.tech`). Mutations from local scripts hit DEV, not prod.
- `apps/web/.env.local.bak.prod-main` → backup with the prod URL. Use this to override `DATABASE_URL` inline when intentionally touching prod:
  ```bash
  DATABASE_URL="$(grep '^DATABASE_URL=' .env.local.bak.prod-main | cut -d= -f2- | tr -d '"')" pnpm exec tsx scripts/<thing>.ts --apply
  ```
- `apps/web/.gitignore` includes `.env.local.bak*` so the backup never enters a commit.

---

## Sprint 5 — Public JSON API (▶ NEXT)

Spec: `.omc/plans/sprints/sprint-5-public-api.md` (read it; this is just orientation).

### Re-check gates (verify before execute)

| Gate | Required | Current |
|---|---|---|
| No schema changes to `agent_findings` for ≥2 weeks | rolling 14d | Last touched in Sprint 1 (PR #16, 2026-05-?). Check: `git log -- apps/web/db/schema.ts` and confirm no edits to the `agentFindings` block in the last 14 days. **Likely passes** unless Sprint 5 work itself touches it. |
| Receipts in corpus | ≥30 | **69** public receipts on prod — passes. |

If both gate, execute. If the schema-stability gate is ambiguous (recent unrelated edit to schema.ts that didn't touch agentFindings), apply the runbook's "fix the gate before the sprint executes" rule — relax to "no breaking changes to the agentFindings column set in ≥2 weeks."

### Sprint 5 shape (from the spec)

External JSON API surface for the data layer so Dune/external tools/operators can consume `agent_findings`, `receipts`, `factory_launches`, `agent_claims`, `weekly_features` without scraping. Likely deliverables:

- `/api/v1/agents` — list agents with findings (paginated; the same shape as `loadAgentIndex` but JSON).
- `/api/v1/agents/[address]` — detail JSON (mirrors `loadAgentDetail`).
- `/api/v1/receipts` — public receipts JSON.
- `/api/v1/factory-launches` — once watcher reactivates; for now returns []. Or skip until then.
- Auth: probably none for v1 (read-only data already public on the site). If rate-limit needed, IP-based throttle.
- OpenAPI spec doc at `/api/v1/openapi.json` so external tools can introspect.
- Docs page (`/docs/api` or similar) explaining endpoints + example curl commands.

Read the spec for the exact shape.

### Working contract for this session

- **All coding tasks → Codex** via `omc team 1:codex`. Prefix with `OMC_SHELL_READY_TIMEOUT_MS=90000`. Sprint 4 used this end-to-end; 6 CODEX chunks all ran cleanly.
- **Voice-sensitive copy / integration / migrations / runbook updates / commit messages / PR bodies → Claude** per runbook §1 delegation policy.
- **Security-critical routes → invoke `security-reviewer` agent** after the Codex worker writes them, before integrating. Sprint 4 caught a HIGH-severity race condition this way.
- **Auto-mode classifier blocks prod writes** by default. The operator must explicitly authorize via the `!` shell prefix or by typing "authorize"/"go" in chat. Don't try to work around — surface, ask, retry.

### Sprint 5 spec read order

1. Goal + re-check gates (top of `sprint-5-public-api.md`).
2. Deliverables — annotate which are `[CODEX]` vs `[CLAUDE]` per runbook §1.
3. Verification + stop conditions.
4. On completion contract — update runbook §3 + §1 in the same PR.

---

## Sprint 6 — Breadth features (DO NOT execute today)

Spec: `.omc/plans/sprints/sprint-6-breadth-features.md`.

### Re-check gates

| Gate | Required | Current |
|---|---|---|
| Distinct agents with ≥1 published finding (excluding `roast:%`) | ≥5 | **1** (autonomopoly). **Fails hard.** |
| Forks of `agent-autonomopoly` or any base template on chain | ≥2 | 0 known. Fails. |

Sprint 6 is gated on data layer growth that hasn't happened yet. The runbook explicitly says: "If a sprint's re-check gate fails, do not execute — re-sequence or update the runbook first." Don't try to override unless the operator has shifted strategy.

Likely actions when Sprint 6 eventually becomes executable:
- Leaderboard (sort agents by various criteria).
- Forks tracker (poll GitHub for repos forking known agent templates).
- Cross-agent finding catalog (browse findings across all agents).

---

## Known follow-ups / deferred work

Not blocking Sprint 5 but worth tracking:

1. **`AGENTS_FACTORY_ADDRESS` env var unset on prod** — factory watcher + dispatcher are dormant. The day the agents-specific factory contract deploys, set this env in Vercel prod + re-add the two cron schedules to `apps/web/vercel.json` + optionally run `backfill-factory.ts` once. See runbook §3 Sprint 3 reactivation instructions.
2. **2 awaiting_approval roast submissions** on prod (see prod data state above). Operator promote/reject decision needed; not blocking.
3. **MEDIUM-3 (IP rate-limit on /api/claim)** and **MEDIUM-5 (Octokit-per-request)** — deferred from Sprint 4 security review. Tracked in PR #25 body; revisit during Sprint 5 if API surface adds more attacker-reachable endpoints.
4. **Upstream omc-teams PR** — `Yeachan-Heo/oh-my-claudecode#3046` bumps codex default timeout to 90s. Still open on upstream as of this handoff. Until merged, **always set `OMC_SHELL_READY_TIMEOUT_MS=90000`** when launching `omc team 1:codex`.
5. **Memory notes that matter**:
   - `env_codex_intel_homebrew_tmux` — the 90s timeout fix.
   - `feedback_antfleet_ops_account` — `gh auth switch --user antfleet-ops` before pushes; commit identity `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>`.
   - `feedback_verify_deploys` — `vercel ls --prod` after every push.

---

## Quick-start checklist for the new session

```bash
# 1. Sync
cd /Users/augstar/projects/antfleet
git checkout main && git pull --ff-only

# 2. Sanity checks
pnpm lint            # 0 errors expected
pnpm format:check    # clean expected
pnpm -F @antfleet/web test    # 321/321 expected
pnpm -F @antfleet/web build   # green expected
vercel ls --prod | head       # latest deploy READY

# 3. Read the runbook, then the Sprint 5 spec
cat .omc/plans/antfleet-runbook.md       # §1, §3
cat .omc/plans/sprints/sprint-5-public-api.md

# 4. Verify Sprint 5 gates against prod
cd apps/web
DATABASE_URL="$(grep '^DATABASE_URL=' .env.local.bak.prod-main | cut -d= -f2- | tr -d '"')" node -e "
require('dotenv').config({ path: '.env.local.bak.prod-main' });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const receipts = await sql\`SELECT COUNT(*)::int AS n FROM reviews WHERE public_receipt = true\`;
  console.log('public receipts:', receipts[0].n);  // should be ≥30
})();
"

# 5. Verify Sprint 4 prod migrations are in place
# (you applied 0013/0014/0015 at the end of the previous session — confirm)
DATABASE_URL="$(grep '^DATABASE_URL=' .env.local.bak.prod-main | cut -d= -f2- | tr -d '"')" node -e "
require('dotenv').config({ path: '.env.local.bak.prod-main' });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
(async () => {
  const t = await sql\`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('agent_claims','weekly_features') ORDER BY table_name\`;
  console.log('sprint-4 tables:', JSON.stringify(t));
})();
"

# 6. Branch + execute Sprint 5
git checkout -b sprint-5-public-api
# Draft TASK.md files under .omc/codex-out/sprint5-NN-<chunk>/
# Launch: OMC_SHELL_READY_TIMEOUT_MS=90000 omc team 1:codex "Read .omc/codex-out/sprint5-NN-<chunk>/TASK.md and execute it. Strict rule: write ONLY under .omc/codex-out/sprint5-NN-<chunk>/. Touch DONE last."
# Integrate, runbook update, push, PR.
```

---

## Project-specific reminders (do not skip)

- Commit author: `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>`. Use `git -c user.name="antfleet-ops" -c user.email="..." commit`.
- PR bodies via heredoc OR `--body-file /tmp/<name>.md` — never inline with backticks (the shell mangles them; we hit this multiple times).
- `git apply` requires proper `@@ -line,len +line,len @@` hunks. If a CODEX-produced patch has empty `@@`, apply manually via Edit tool.
- `vercel.json` cron schedules: `/api/cron/poll-factory` and `/api/cron/run-prelaunch` are intentionally removed. Don't re-add unless the agents factory deploys.
- The `roast-runner` only picks up `status='queued'` — anything in `awaiting_approval` waits for explicit operator promote via `scripts/roast-moderate.ts promote <id> --apply`.

---

## Sprint 4 retrospective (for context only)

What worked:
- Codex via omc-teams for 6 schema/API/page chunks. All clean dispatch with 90s timeout.
- security-reviewer agent caught a HIGH race condition before it shipped.
- Per-deliverable TASK.md drafts gave Codex enough context to produce near-final code first try.

What didn't work / lessons:
- Some Codex `@@`-style patches don't apply with `git apply`. Apply manually.
- Building the homepage at static-render time crashed because `weekly_features` didn't exist on prod. Always `export const dynamic = 'force-dynamic'` on any page that reads new DB tables until the migration lands; cleaner anyway.
- Gate-failure operator overrides should be loudly documented in the PR body, not buried. Sprint 4 PR did this.

Good luck.
