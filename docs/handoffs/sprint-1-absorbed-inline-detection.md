# Sprint 1 — Absorbed-Inline Closure Detection (Handoff)

**Sprint dates**: 2026-05-26 → 2026-05-27
**Status**: COMPLETE (production verified end-to-end)
**Executor**: autopilot (sprint execution) + operator (verification + bug fixes)
**Predecessor brief**: `docs/autopilot/absorbed-inline-detection-brief.md`
**Successor brief**: `docs/autopilot/finding-level-closure-watcher-brief.md`

This handoff is the durable record of what Sprint 1 shipped, what bugs surfaced during verification, and what Sprint 2 inherits. It's the operational reference for anyone (human or agent) picking up the work.

---

## Problem this sprint solved

When AntFleet opens an upstream fix PR, three outcomes are possible:

| Outcome | Description | Old DB state |
|---|---|---|
| `merged` | Our PR got merged upstream | `status='merged'`, mergeSha captured |
| Decline | Our PR closed with no fix anywhere | `status='closed'` — correctly final |
| **Absorbed inline** | **Our PR closed, but the maintainer ported the fix into a separate commit on main** | **`status='closed'` — INDISTINGUISHABLE from decline** |

Pre-Sprint 1, the cron sweep had no way to tell decline from absorbed-inline — both were `closed`. This **structurally under-counted AntFleet's signal value by ~50%** for the receipts page and the eval corpus. The agent-autonomopoly bench produced two cases of this (PR #5 and PR #8) where the maintainer ported AntFleet's fix into their own commit without merging.

Sprint 1 fixed this by adding LLM-judged absorbed-inline detection to the cron sweep, plus a new `closed_absorbed` status surfaced as receipt-eligible.

## What shipped

### Schema (migration `0026_outgoing_prs_closure_method`)

New columns on `outgoing_prs`:

- `closure_method text` — `merged | absorbed_inline | declined | stale_timeout` (nullable until classified)
- `closure_sha text` — upstream commit SHA that applied the fix, regardless of whether via our PR (mergeSha) or via a separate commit (absorbed_inline)
- `closure_detected_at timestamptz`
- `closure_confidence real` — `0.0..1.0` (LLM judge confidence; null for clean merges)
- `closure_notes text` — judge reasoning text (audit trail)

The `status` enum gained `closed_absorbed` alongside the existing `open | merged | closed`.

### Code

| File | Role |
|---|---|
| `apps/web/lib/absorbed-inline.ts` | LLM-judge detection module. `detectAbsorbedInline(pr, deps)` returns `{absorbed, commitSha, confidence, reasoning}` |
| `apps/web/lib/outgoing-prs.ts` | Cron-tick poll wiring. `runOutgoingPrsPoll()` polls each `outgoing_prs` row, calls `detectAbsorbedInline` on closed-without-merge transitions, writes results |
| `apps/web/scripts/backfill-absorbed-inline.ts` | One-shot script for historical row backfill. Has reference-data validation baked in (PR #5 → bab1e4b, PR #8 → 7329b8a) |
| `apps/web/app/api/cron/sweep/route.ts` | Cron route invokes `runOutgoingPrsPoll()` alongside existing finding sweep + onboarder |
| `apps/web/app/receipts/page.tsx` | Renders `closed_absorbed` rows as receipts (alongside `merged`) — single "fix landed" badge, granularity preserved in DB |
| `apps/web/app/impact/page.tsx` | New route summarizing findings → fixes (also lists absorbed-inline receipts) |
| `apps/web/lib/receipts.ts` | Receipt query/projection abstraction |
| `apps/web/db/queries.ts` | Query helpers updated to handle the new closure dimensions |

### Commits (chronological)

| SHA | Message | Notes |
|---|---|---|
| `ec3d8aa` | `feat(sweep): absorbed-inline closure detection for outgoing PRs` | Main sprint deliverable (autopilot's first pass) |
| `3365af3` | `fix(sweep): address code audit findings for absorbed-inline detection` | Autopilot's self-audit pass before declaring done |
| `acb54a1` | `docs: update upstream-fix-prs with absorbed-inline status + PR #4` | Updated tracker doc; left "pending cron detection" for PR #5/#8 pending real cron verification |
| `c94a6e9` | `fix(backfill): force dotenv override for absorbed-inline script` | Local-tooling bug (see Bug 4 below) |
| `4a5322f` | `fix(absorbed-inline): widen candidate window + relax judge on cosmetic gaps` | Two algorithm bugs in one commit (Bugs 2 + 3 below) |
| `24417d3` | `chore: trigger deploy for PAT rotation` | Empty commit to force redeploy after `ANTFLEET_OPS_GH_TOKEN` rotation in Vercel env |
| `ce6c1b1` | `fix(outgoing-prs): move writePostDraft outside DB transaction` | First attempt at the cron-error fix — addressed the EROFS layer of the transaction problem (Bug 1a below). Insufficient on its own; superseded by `ce916b8`. |
| `ce916b8` | `fix(outgoing-prs): drop db.transaction — neon-http driver has no transaction support` | Actual root-cause fix — see Bug 1b below |
| `f14466b` | `fix(claim): use neon-serverless driver so /api/claim's transaction works` | Sister bug resolution (not Sprint 1 directly, but discovered during Sprint 1 audit) — see "Known follow-ups" below |

Plus PAT rotation (Vercel env mutation only — no code commit; tracked separately in project memory).

## Verified outcomes

### Reference data (golden cases for ongoing validation)

| Outgoing PR | Upstream PR | Outcome | closure_method | closure_sha | confidence |
|---|---|---|---|---|---|
| PR 1 (threshold harmonization) | `Liquid-Protocol-Ops/agent-autonomopoly#3` | merged | `merged` | `3299eed8c52f41ed01e1a249c0e6c7b6f4e3c649` | n/a |
| PR 2 (husky prepare) | `#4` | merged | `merged` | `fb5509ce5d31cc108492e1e5b6637253ae0912d2` | n/a |
| **PR 3 (FeeLocker selector)** | `#5` | **absorbed inline** | `absorbed_inline` | `bab1e4b` | 0.90 |
| **PR 4 (token0<token1 ordering)** | `#8` | **absorbed inline** | `absorbed_inline` | `7329b8a` | 0.90 |
| Aeon dogfood PRs | `aaronjmars/aeon#202`, `#224` | declined | `declined` (judge ran, no candidates matched) | — | n/a |

These cases are the reference data anyone testing Sprint 1 (or Sprint 2's similar logic) should validate against. The backfill script enforces this on its own via the in-script reference validation.

### Production cron behavior verified

After the PAT rotation and bug fixes landed, the production cron successfully:
- Polled `thewaltero/mythos-router#13` → returned `merged` (PR was actually merged at `11defd4a`)
- Polled `whetstoneresearch/doppler#521` → returned `declined` (no matching upstream commit, judge correctly conservative)
- Honored honest-report gate: when LLM judge confidence < 0.7, defaults to declined

### Headline claim (now data-backed in prod DB)

> **"4 substantive PRs filed on agent-autonomopoly, 4/4 underlying fixes landed within 8 days. AntFleet's signal preceded the fix in 100% of cases."**

2 via clean merge (PR #3, PR #4), 2 via absorbed-inline (PR #5, PR #8). The git timeline (our PR opens dated 2026-05-18-20, upstream commits dated 2026-05-26) is the durable receipt regardless of merge attribution.

## Bugs found during verification

Sprint 1's autopilot pass landed working code that nonetheless contained four bugs surfaced only during operator verification. All are now fixed. Listed in order of discovery + fix:

### Bug 1 — `db.transaction()` cluster (commits `ce6c1b1` + `ce916b8`)

This was actually **two stacked failures** discovered in the same debugging session. The first attempted fix (`ce6c1b1`) addressed one layer; the actual root-cause fix (`ce916b8`) was needed to fully resolve. Future debuggers should expect this kind of stacked-failure pattern.

#### Bug 1a — `writePostDraft` inside transaction → EROFS rollback (commit `ce6c1b1`)

**Root cause**: `markMerged`, `markClosed`, and `markAbsorbed` in `apps/web/lib/outgoing-prs.ts` wrapped their DB updates AND a `writePostDraft()` call inside `db.transaction()`. `writePostDraft` writes to the local filesystem (`.omc/state/posts/`). In Vercel serverless functions the root filesystem is read-only — only `/tmp` is writable — so `mkdir` threw EROFS.

**Symptom**: Inside the transaction, the EROFS error rolled back the DB update. The catch handler logged a generic poll_failed and moved on, leaving the PR at `status='open'` indefinitely.

**Fix**: Extract `writePostDraft` from the transaction. Commit DB update first, then attempt the draft write with a non-fatal `logWarn` on failure.

#### Bug 1b — `db.transaction()` itself unsupported on neon-http (commit `ce916b8`)

**Root cause**: After fixing 1a, the cron still failed. The shared db instance (`apps/web/db/index.ts`) uses `drizzle-orm/neon-http`, which **does not support multi-statement transactions** — `db.transaction()` itself throws `"No transactions support in neon-http driver"` at runtime, regardless of what's inside it.

**Symptom**: Same as before — every cron tick reported errors on closed-without-merge PRs (`mythos-router#13`, `doppler#521`). The exception was caught by the per-PR error handler, so the cron didn't crash — but PRs got stuck at `status='open'` forever because no successful update was reachable.

**Fix**: Replaced `db.transaction(async tx => { ... })` with plain `db.update(...).returning()` in all three functions. Each touches a single row, so no transaction semantics are needed once `writePostDraft` is outside.

**Generalized lesson** (covers both 1a + 1b): **Never use `db.transaction()` in any code path reachable from the cron with the neon-http driver. AND never do filesystem writes inside any DB transaction in a serverless function context.** Single-row writes use `db.update(...).returning()`. Multi-row atomic writes use CTE/UPSERT at SQL level OR switch the route to `drizzle-orm/neon-serverless` (which supports transactions but adds connection overhead — that's what `/api/claim` ended up doing, see commit `f14466b`).

### Bug 2 — `MAX_CANDIDATE_COMMITS = 20` too narrow (commit `4a5322f`)

**Root cause**: In `apps/web/lib/absorbed-inline.ts`, the candidate-commits window was capped at 20. In repos with heavy automated commit noise (e.g., autonomopoly's cron-failure loop emits ~5 commits/hour), a 20-deep window reaches back only ~4 hours.

**Symptom**: PR #8's absorbing commit (`7329b8a`) was authored 26h before the verification cron tick. It fell outside the 20-commit window, so the matcher never saw it. PR #5 happened to work because its absorbing commit (`bab1e4b`) was at position 11 within the window.

**Fix**: Raised the constant to 100. The file-overlap pre-filter still bounds LLM cost — only commits touching PR-overlapping files get judged. Cost impact: negligible (cheap GitHub API call per candidate; LLM judge only fires on file-overlap matches, which is the same ~5 per PR regardless of window size).

**Generalized lesson**: For Sprint 2 and beyond, the candidate window should be sized for repos with bot-driven commit noise. 100 is a reasonable default; higher if a repo is known to be especially noisy.

### Bug 3 — Judge prompt rejected partial absorption (commit `4a5322f`)

**Root cause**: The original judge prompt required the candidate commit to "contain the substance of the PR's fix" without distinguishing functional vs cosmetic parts. PR #8 had two changes: (a) the assert `token0 < token1` assertion (functional), (b) a `computeNewRange` comment correction (cosmetic). The closing commit `7329b8a` ported (a) but skipped (b) — so the judge correctly observed the commit didn't contain the FULL PR but returned `equivalent: false` at confidence 0.85.

**Symptom**: Reference data validation failed at the `--apply` step. PR #8's absorbing commit was identified by the judge but rejected as "not equivalent" because the cosmetic comment fix wasn't ported.

**Fix**: Refined the judge prompt to distinguish substantive vs cosmetic parts. The criterion is now: *"the commit must apply the functional behavioral change from the PR; the commit MAY OMIT secondary parts like documentation, comment corrections, formatting, or cosmetic improvements — that's fine, as long as the functional substance is present."* Plus an explicit instruction: *"do NOT conflate 'missing cosmetic part' with 'wrong fix' — partial absorption of the PR's substantive change is still a match."*

**Generalized lesson**: When tuning a judge for software engineering work, explicitly distinguish what counts as the "substance" of a fix versus secondary improvements. The prompt should accept bundled extra work AND missing cosmetic edits, but reject semantic divergence on the actual fix.

### Bug 4 — `dotenv` doesn't override empty parent env (commit `c94a6e9`)

**Root cause**: When Claude Code (or any parent shell) pre-sets `ANTHROPIC_API_KEY=""` as an empty value, dotenv's default behavior is to NOT override existing env vars — even empty ones. The backfill script's `dotenv.config({ path: ".env.local" })` therefore loaded all OTHER keys but left ANTHROPIC_API_KEY as empty. The LLM judge then threw `"ANTHROPIC_API_KEY is required for absorbed-inline judge"` at the call site, was caught by per-PR error handler, returned `declined` silently for every row.

**Symptom**: Local backfill runs in Claude Code sessions reported every row as `declined` without the judge ever running. Detectable only by inspecting the log lines.

**Fix**: Added `override: true` to the dotenv config call: `dotenv.config({ path: ".env.local", override: true })`. Forces the .env.local value to win over the (empty) shell value. No effect in production — Vercel sets env vars directly, not via dotenv.

**Generalized lesson**: All scripts that read `.env.local` in apps/web/scripts/ should use `override: true` if they may be invoked from inside Claude Code or similar parent environments. Failure mode is silent and the symptom mimics "judge correctly declined everything."

## Operational notes (recurring tasks)

### How to force-tick the production cron

```bash
cd /Users/augstar/projects/antfleet
CRON_SECRET="$(grep '^CRON_SECRET=' apps/web/.env.local | sed 's/^CRON_SECRET=//; s/^"//; s/"$//')"
curl -sS --max-time 200 \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://www.antfleet.dev/api/cron/sweep \
  | jq '{swept, outgoingPrs, elapsedMs}'
```

Expected: `outgoingPrs.errors: 0` (post-rotation + post-fix). If errors appear, check Vercel logs and `outgoing_prs.status` distribution.

### How to run the backfill locally

```bash
cd /Users/augstar/projects/antfleet/apps/web
ANTHROPIC_API_KEY="$(grep '^ANTHROPIC_API_KEY=' .env.local | sed 's/^ANTHROPIC_API_KEY=//; s/^"//; s/"$//')" \
ANTFLEET_OPS_GH_TOKEN="$(gh auth token --user antfleet-ops)" \
pnpm exec tsx scripts/backfill-absorbed-inline.ts        # dry run
pnpm exec tsx scripts/backfill-absorbed-inline.ts --apply  # writes to prod DB
```

Reference validation is baked into the script — exits with code 1 if PR #5 doesn't match `bab1e4b` or PR #8 doesn't match `7329b8a`. Do not bypass this gate.

### How to verify a Vercel deploy after push

```bash
cd /Users/augstar/projects/antfleet
vercel ls --prod | head -5
```

Top entry should be "Ready" with age "<5m" after a fresh push. Errors mean the build failed — investigate before declaring sprint progress.

### How to query closure outcomes in prod DB

```sql
SELECT
  upstream_owner || '/' || upstream_repo || '#' || upstream_pr_number AS pr,
  status, closure_method,
  LEFT(closure_sha, 7) AS closure_sha_7,
  closure_confidence
FROM outgoing_prs
ORDER BY opened_at DESC
LIMIT 20;
```

## Known follow-ups + dependencies

### Sister bug — RESOLVED via commit `f14466b`

**`apps/web/app/api/claim/route.ts:137`** used `db.transaction()` for a multi-statement transaction that genuinely needs atomicity (race-vs-concurrent-claim case). The neon-http driver doesn't support transactions, so this would have thrown if hit. The route was dead code at the time (`agent_claims` and `factory_launches` both at 0 rows), so the bug was latent.

A task chip was filed during Sprint 1 verification to track this. **It got picked up and resolved in commit `f14466b`** — Option 1 from the task brief (switch the route to `drizzle-orm/neon-serverless` driver, which supports transactions but adds WebSocket connection overhead). The other code paths (cron sweep, etc.) still use neon-http; only `/api/claim` was switched.

No longer a known follow-up. Listed here for the chronological record.

### PAT rotation hygiene

- New PAT (Classic, `public_repo` scope) installed in Vercel env 2026-05-27.
- Old PAT (fine-grained, scope-limited) revoked.
- **Expiration**: ~2026-08-25 (90 days from 2026-05-27).
- Next rotation due: **~2026-08-15** (set a reminder).

### `/receipts` page surface

`closed_absorbed` rows are now receipt-eligible alongside `merged`. The UI shows a single "fix landed" badge regardless of closure method (granularity preserved in DB for audit/eval purposes; UI keeps it simple).

If a future sprint adds opt-in per-closure-type filtering on the page, the data is already there — no schema changes needed.

### Cron-tick budget

Sprint 1's `runOutgoingPrsPoll()` runs inside the `/api/cron/sweep` route alongside the finding sweep + onboarder check-ins. The route's `maxDuration` is 180s. Current elapsed times observed:

- Sweep only: ~30-35s
- + Onboarder: ~35-40s
- + Outgoing PRs poll (7 rows, mixed succeed/error): ~5-10s extra

Total tick budget: well within 180s. Sprint 2 adds finding-upstream-poll on top of this; the brief allocates 150s ceiling and reduces per-tick `LIMIT` if needed.

## What Sprint 2 inherits from Sprint 1

### Schema patterns (parallel structure)

Sprint 2 extends `findingStatus` with the same shape of closure columns: `upstream_closure_method`, `upstream_closure_sha`, `upstream_closure_detected_at`, `upstream_closure_confidence`, `upstream_closure_notes`, plus polling-specific `upstream_last_polled_at` and `upstream_poll_attempts`. Mirror the Sprint 1 column-naming pattern.

### Reference data

The four cases above (PR #5, #8, #3, #4 plus the two aeon PRs) remain valid as integration test fixtures for any closure-detection logic. Sprint 2's matcher should pass them as a smoke test before being trusted on new findings.

### Algorithmic patterns

- Hybrid matcher: line-range pre-filter → cheap judge → expensive judge escalation (Sprint 2's haiku → opus pattern parallels Sprint 1's confidence-thresholded LLM call).
- Honest-report gate: when uncertain, default to "not closed yet" / "declined," never optimistically claim closure.
- File-overlap pre-filter: cheaper than running the LLM judge on every candidate; Sprint 2 broadens this to a line-range filter for finding-specific cases.

### Lessons embedded in the Sprint 2 brief

All four Sprint 1 bug categories (db.transaction, dotenv override, candidate window size, prompt substantive-vs-cosmetic) are documented as inherited lessons in `docs/autopilot/finding-level-closure-watcher-brief.md`. The brief explicitly forbids reintroducing those patterns.

## File index (Sprint 1 artifacts)

| File | Purpose |
|---|---|
| `apps/web/db/migrations/0026_outgoing_prs_closure_method.sql` | Schema migration |
| `apps/web/db/schema.ts` (outgoingPrs section) | Drizzle schema definition |
| `apps/web/lib/absorbed-inline.ts` | LLM-judge detection module |
| `apps/web/lib/outgoing-prs.ts` | Cron poll wiring |
| `apps/web/scripts/backfill-absorbed-inline.ts` | Backfill script with reference validation |
| `apps/web/app/api/cron/sweep/route.ts` | Cron route invocation |
| `apps/web/app/receipts/page.tsx` | Receipts UI rendering |
| `apps/web/app/impact/page.tsx` | Impact page |
| `apps/web/lib/receipts.ts` | Receipt query abstraction |
| `apps/web/lib/receipts.test.ts` | Tests |
| `docs/autopilot/absorbed-inline-detection-brief.md` | Sprint 1 brief (input) |
| `docs/demos/upstream-fix-prs.md` | Human-readable tracker for outgoing PRs (also has reference data) |
| `docs/handoffs/sprint-1-absorbed-inline-detection.md` | This file |

## Open questions

None remain for Sprint 1 itself. The work is verified end-to-end in production. Sprint 2 has its own open questions, resolved in the design session and baked into its brief.

If a future contributor finds Sprint 1 behavior that diverges from this handoff, the discrepancy is a bug or drift — open an issue and tag it `sprint-1-regression`.
