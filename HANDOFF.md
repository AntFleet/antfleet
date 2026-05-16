# Session handoff — pick up here

This file is the resume sheet for the next session. It's transient — delete it once Mission 4 is fully done and start a clean handoff for whatever follows.

**Last session ended:** 2026-05-17, after Mission 3 closed.
**Last commit:** `75ff270` (`feat(web): Mission 3 slice 3-6 — vercel.json cron schedule + close Mission 3`)
**Working tree:** clean (modulo this file committing alongside the slice).

---

## What's done

`AGENTS.md §4` has the full table — Missions 1 and 3 are complete. The end-to-end pipeline (webhook → 2-of-2 unanimous review → PR comment → finding lifecycle → daily sweep → closure receipts + reaction polling) is wired in code AND locally smoke-tested. The only ops gap remaining is the production deploy itself.

## Ops state (all local-smoke prerequisites cleared 2026-05-17)

1. ~~Apply pending Neon migrations~~ — **done via `db:push`.** Neon schema current as of `0003_high_maggott`. Future schema changes: use `pnpm -F @antfleet/web db:push`, NOT `db:migrate`. The repo's `__drizzle_migrations` tracking table on Neon is empty (original schema seeded via push), so `db:migrate` re-applies 0000 from scratch and fails with "relation already exists." Push diffs schema.ts against actual DB and applies only what's missing — non-destructive changes (column adds, constraint adds) auto-apply without prompts.

2. ~~`CRON_SECRET` in Vercel env~~ — **done in Production + Development**, mirrored to `apps/web/.env.local`. **Preview env still skipped** — Vercel CLI 53.4.0 has a bug where `vercel env add CRON_SECRET preview --value <v> --yes` returns its own command as a "next step" suggestion and exits 0 without saving. Workaround: add via Vercel dashboard if/when smoke-testing preview URLs becomes useful. Cron only fires on production deployments, so this doesn't block the schedule.

3. ~~Backfill M3-1 smoke row's repo coords~~ — **done.** `review_id=83e79770-1869-4331-8690-b534a531d327` now has `installation_id=132854945`, `owner='Augustas11'`, `repo='krisskross_shops'`. The 4 open finding_status rows on that review are sweepable.

4. ~~Local smoke~~ — **done.** `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sweep` returned `{swept:4, closed:0, reactionsRecorded:0, reviewsSkipped:0, errors:[], elapsedMs:7327}`. Auth gate: 401 on missing/wrong header. The cron pipeline works end-to-end against real Neon + real GitHub.

5. ~~Vercel project Git connection~~ — **done.** `apps/web` (project `antfleet-web`) is now connected to `https://github.com/Augustas11/antfleet`. Future `git push` to `main` auto-deploys to production. Side effect: `.gitignore` at repo root now lists `.vercel` (Vercel CLI added this automatically when it briefly mis-linked at the root before being redirected to `apps/web/`). Defensive — kept.

6. **Production deploy + cron activation — not done.** Next `git push origin main` triggers the first Vercel production build. The cron schedule (`apps/web/vercel.json`) starts firing once a production deployment exists — first scheduled run is 06:00 UTC the day after the first prod deploy. (For an immediate first deploy without waiting on a push, `cd apps/web && vercel deploy --prod`.)

7. **Zombie Vercel project to clean up.** When Vercel CLI was first run from the repo root, it auto-created a spurious project named `antfleet` (separate from the real `antfleet-web`). It has no deployments, env vars, or domains attached and is harmless, but should be deleted from the Vercel dashboard (Projects → antfleet → Settings → Delete). The auto-deletion via `vercel project rm antfleet` was blocked by the agent's auto-mode classifier; user action needed.

## What's next: Mission 4

Per AGENTS.md §9 MVP scope:

- **Landing page** at `/` — Next.js single-pager. Stripe + Linear aesthetic per §15 (clean, numerical, receipts-forward, sans-serif, generous whitespace, monospace only for code/SHAs). Install button as primary CTA (GitHub App install URL).
- **Public receipts page** at `/receipts` — live counter as hero. Pulls from `finding_status` where `status='closed'`. Each receipt: finding id, closure SHA (linked to commit), original PR (linked). This is the public, verifiable, growing artifact that AGENTS.md §18.2 names by name as the moat.
- **Data policy** in footer + a `/policy` (or `/data-policy`) page. References the opt-in eval-corpus contribution language from §9.

**Mission 4 has not been sliced yet.** Recommended slicing (open to redrafting):

| Slice | Scope |
|---|---|
| 4-1 | Page chrome: shared layout, nav, footer, base typography/spacing tokens (Tailwind config + minimal shadcn pieces). Static-only — no data dependencies. |
| 4-2 | Landing page `/` — hero, install button (GitHub App install URL pointing at the App's public install page), explainer of the unanimous-on-2 pitch from §15. |
| 4-3 | Public receipts page `/receipts` — server component reading `finding_status` (status='closed'), displaying receipt rows with closing-SHA links. Hero counter shows total closed count. |
| 4-4 | `/policy` page — data policy text. Footer link from every page. |
| 4-5 | Receipts page polish — small SHA, repo anonymization toggle (or default to repo_hash), pagination if N grows beyond a screen, "last updated" stamp. |

**Open design question for Mission 4-3**: anonymization. `finding_status` joined to `reviews` gives us owner/repo (slice 3-5 just added those columns), but per AGENTS.md §10 the privacy boundary says "per-customer data accessed only via explicit auth" — public `/receipts` should NOT leak owner/repo unless the customer opts in. Likely default: show only `repo_hash` (or a short prefix) and the closing SHA, with an opt-in mechanism for customers who want public attribution. Pin this down before writing 4-3.

## Resume sequence

```bash
cd /Users/augstar/projects/antfleet
git log --oneline -25
pnpm install
pnpm -w build
pnpm -F @antfleet/web test   # baseline: 90 passing
pnpm -F @antfleet/web dev    # NOTE: future schema changes use db:push, not db:migrate (see Ops debt #1)
```

## State you might have forgotten

- **Smee client** may or may not still be running. `pgrep -f smee-client`. Restart: `pnpm dlx smee-client --url https://smee.io/PCgyaSg2iXGWP66P --target http://localhost:3000/api/github/webhook`.
- **Vercel project**: `augstar-8472s-projects/antfleet-web`, linked. `.vercel/project.json` lives at `apps/web/.vercel/`.
- **Neon**: `neon-fulvous-zebra`, project id `solitary-dew-96858656`. Schema head in repo at `0003_high_maggott`; production Neon may still be on `0001_friendly_beast` (see Ops debt #1).
- **GitHub App install URL** — needed for the landing page CTA. Get from the GitHub App settings page (the App owned by the Augstar account that controls the test repo `krisskross_shops`). Likely shape: `https://github.com/apps/<app-slug>/installations/new`.
- **Existing finding_status rows in Neon**: 4 open rows on review `83e79770-1869-4331-8690-b534a531d327`. Will count toward the receipts page if they close.

## Things to avoid

- **Don't pull Vercel env directly into `apps/web/.env.local`** — overwrites manually-added keys. Use `vercel env pull .env.vercel.tmp --yes` and merge by hand.
- **Don't symlink `apps/web/.env.local`** — Vercel auto-pull writes through it.
- **Don't put owner/repo on the public receipts page** without an opt-in mechanism — see AGENTS.md §10 ("per-customer data accessed only via explicit auth").
- **Don't change `/api/cron/sweep` from GET to POST** — Vercel cron calls GET. Flipping the export breaks the schedule.

## When you finish a slice

1. `pnpm -F @antfleet/web typecheck && pnpm -F @antfleet/web test && pnpm -F @antfleet/web build && pnpm -w test`
2. Commit with the `Mission 4 slice 4-X` prefix matching prior commits.
3. Update `AGENTS.md §4`'s Mission 4 table — flip the next row from `—` to `✓` with the new commit hash. (Add a Mission 4 section to §4 first if you're the first to land a 4-X slice.)
4. Once Mission 4 is fully done: delete this file and start a clean handoff for whatever's next (likely Phase 2 design-partner onboarding per §5).
