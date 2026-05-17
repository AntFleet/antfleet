# Session handoff — pick up here

This file is the resume sheet for the next session. It's transient — delete it once the next phase milestone closes and start a clean handoff for whatever follows.

**Last session ended:** 2026-05-17, after Mission 4 + first-receipt smoke test.
**Last commit:** `d91bbf8` (`chore(web): scripts/trigger-sweep admin tool for on-demand cron firing`)
**Working tree:** clean.

---

## Phase 1 — complete

All four MVP missions per AGENTS.md §5 Phase 1 are shipped and deployed:

| Mission | Slices | Final commit |
|---|---|---|
| 1 — GitHub App skeleton + review pipeline + PR comments | 1, 2, 3, 4a–4d | `3ab052a` |
| 3 — Sweeper + receipts + reaction polling | 3-1 … 3-6 | `75ff270` |
| 4 — Landing page + receipts page + policy + polish | 4-1 … 4-5 | `21c796d` |
| (Mission 2 was absorbed into M1 4b — pipeline + comment posting landed together.) | | |

## First-receipt smoke test — done (2026-05-17)

Production end-to-end lifecycle validated on `Augustas11/antfleet` itself:

1. **PR #3** opened with `/api/health` improvement (real new feature — replaces scaffold stub)
2. Webhook fired, HMAC verified, App auth succeeded, files fetched, both providers reviewed in 36s
3. Agreement gate produced **1 unanimous finding** (Security/High — info disclosure in the health response body)
4. AntFleet bot posted the review comment on PR #3
5. Fix commit `84a54c1` addressed the finding (response body limited to `{ ok }` only; diagnostics moved to server logs)
6. Squash merged to main as `4640404a`
7. Manual sweep triggered via `scripts/trigger-sweep.ts` → `swept:5, closed:1`
8. Closure receipt comment posted on PR #3
9. **`/receipts` counter incremented 0 → 1** — first public, SHA-pinned receipt

PR #1 (short-id refactor) and PR #2 (maxDuration bump) are evidence in the trail:
- PR #1 = first production smoke test. Both reviews completed cleanly but no agreed findings (clean refactor, no overlap). Closed without merging; receipts logic intact.
- PR #2 = the discovered 60s self-imposed webhook ceiling was incompatible with multi-file PRs. Bumped to 300s (Pro plan ceiling). Squash-merged.

## What was set up this session that previous handoff didn't have

### Vercel production env (all 5 secrets pushed)

| Env var | Why | Pushed via |
|---|---|---|
| `GITHUB_APP_ID` | App auth | `scripts/push-prod-env.ts` |
| `GITHUB_APP_PRIVATE_KEY` | Mint installation tokens (multi-line PEM, ~1700 chars) | `scripts/push-prod-env.ts` |
| `GITHUB_APP_WEBHOOK_SECRET` | HMAC verify incoming webhooks | `scripts/push-prod-env.ts` |
| `ANTHROPIC_API_KEY` | Claude Opus 4.7 review | `scripts/push-prod-env.ts` |
| `OPENAI_API_KEY` | GPT-5 review | `scripts/push-prod-env.ts` |

`scripts/push-prod-env.ts` is the documented pattern — reads selected vars from `.env.local`, pipes to `vercel env add NAME production --yes` over stdin so values never appear in command lines, history, or output. Use it for future credential rotations or adding new prod secrets.

### GitHub App config

- **Webhook URL** repointed from `https://smee.io/PCgyaSg2iXGWP66P` to `https://antfleet-web.vercel.app/api/github/webhook` (done by user on github.com)
- **Installed on** `Augustas11/antfleet` (Only-select-repositories scope)
- **Bot user** posts as `antfleet[bot]` (shows up as login `antfleet` in gh CLI)
- **Webhook secret** byte-matches `GITHUB_APP_WEBHOOK_SECRET` in Vercel prod env

### Production schema

- `db:push` applied migration `0004_eager_psynapse` (adds `reviews.public_receipt boolean default false not null`)
- Schema head in repo + production: `0004_eager_psynapse`
- The drop+recreate of `maintainer_reactions_dedup` during the push was drizzle-kit's idempotent re-sync — no data effect

### Opted-in for public receipts

`scripts/enable-public-receipts.ts` is the documented opt-in pattern — owner-only form opts in all repos under a login/org; owner+repo form scopes to one repo. Idempotent.

Current opt-in: `Augustas11` (4 review rows flipped). For future design partners, run:
```
pnpm exec tsx scripts/enable-public-receipts.ts <owner> [<repo>]
```

## Phase 1 → Phase 2 gate — half crossed

Per AGENTS.md §5: "1 design partner repo live, public receipts counter > 0."

| Criterion | Status |
|---|---|
| Public receipts counter > 0 | ✅ counter = 1 (Augustas11/antfleet PR #3 closure) |
| Design partner repo live | ⏳ external design partner not onboarded yet — dogfood doesn't count |

The remaining work is **outreach**, not code. Per AGENTS.md §8.1 (just locked this session), v1 design partners are CAC, not COGS — 5–10 partners on free tier with rate limits, no Stripe.

## Phase 2 prep — useful to do before first design-partner conversation

In rough priority order:

1. **Custom domain.** `antfleet-web.vercel.app` reads less serious for b2b. Register `antfleet.dev` (or whatever's available) and attach via `vercel domains add`. ~$12/year. Quick win.

2. **`privacy@antfleet.dev` mailbox.** The `/policy` page tells customers to email this address to enable public receipts. Currently dead-letter. Needs a real inbox (Gmail forwarding, ImprovMX, or wherever).

3. **Onboarding doc.** When you say "yes, install AntFleet on your repo" to a design partner, what's the exact set of steps you hand them? Currently undocumented. Should cover: install URL, single-repo recommendation, what to expect in their first PR review, where receipts appear, how to enable public receipts, how to uninstall. One page.

4. **Phase 2 metrics dashboard plan.** Per §5 Phase 2: "Weekly metrics review: per-repo recall, noise, time-to-close." Needs a basic admin surface or even just a SQL query template. Could be slice-of-slice (one query per metric) or a simple `/admin/metrics` page behind a Vercel password.

5. **Onboarding pitch.** What's the exact 30-second ask when reaching out to a developer friend? Variants worth A/B-ing: "be receipt #2 on AntFleet" / "free PR review on your repo, contributes to a public audit corpus" / etc. Doesn't need to be locked but worth sketching.

## Ops items still pending (carried forward)

These were carried from the previous handoff and are still open:

1. **Zombie `antfleet` Vercel project.** Was auto-created when Vercel CLI first ran from repo root. No deployments/env/domains, harmless. `vercel project rm antfleet` blocked by classifier; needs dashboard delete (Projects → antfleet → Settings → Delete).

2. **`CRON_SECRET` in Vercel Preview env.** Vercel CLI 53.4.0 bug — `vercel env add CRON_SECRET preview --value <v> --yes` echoes its own command and exits 0 without saving. Dashboard add still works. Not blocking — cron only fires on production.

3. **Krisskross_shops reaction polling error.** First sweep run returned an error:
   ```
   batch · reviewId 83e79770 · "reaction pass: Not Found"
   ```
   This is the original M1 krisskross_shops review row. Either the PR comment was deleted or the App lost access to that repo (it was uninstalled). Doesn't affect new reviews. Cleanup options:
   - Set `status='superseded'` on its 4 finding_status rows so the sweeper stops trying to poll
   - Or delete the rows entirely (cascades from `reviews` deletion)

## Resume sequence

```bash
cd /Users/augstar/projects/antfleet
git log --oneline -25
pnpm install
pnpm -F @antfleet/web test   # baseline: 105 passing
pnpm -F @antfleet/web dev    # local dev server (webhook will need smee tunnel)
```

## State you might have forgotten

- **Vercel project:** `augstar-8472s-projects/antfleet-web`, linked. `.vercel/project.json` at `apps/web/.vercel/`. On Pro plan.
- **Neon:** `neon-fulvous-zebra`, project id `solitary-dew-96858656`. Schema head: `0004_eager_psynapse`.
- **GitHub App:** installed on `Augustas11/antfleet`. Webhook → `https://antfleet-web.vercel.app/api/github/webhook`. Posts as `antfleet[bot]`.
- **Production cron:** daily 06:00 UTC. Manual trigger via `pnpm exec tsx apps/web/scripts/trigger-sweep.ts` (admin tool, reads `CRON_SECRET` from `.env.local`).
- **Dogfood receipt rows:** review `f1b5393a-ee36-4af0-b797-a98826c45dcb` has 1 closed finding (the PR #3 info-disclosure closure). This is the seed of the receipt corpus.

## Things to avoid

- **Don't pull Vercel env directly into `apps/web/.env.local`** — overwrites manually-added keys. Use `vercel env pull .env.vercel.tmp --yes` and merge by hand.
- **Don't reintroduce env-var leaking in `/api/health` response body** — the §15 + PR #3 reasoning is the precedent. Diagnostics go to server logs.
- **Don't lower `webhook/route.ts` maxDuration below 300** — PR #1 proved 60s is insufficient for multi-file reviews even at Pro.
- **Don't change `/api/cron/sweep` from GET to POST** — Vercel cron calls GET. Flipping the export breaks the schedule.
- **Don't introduce fake bugs to populate `/receipts`** — per §12 honest-report, the counter must reflect real agreement on real PRs. Manufactured findings poison the trust artifact.
