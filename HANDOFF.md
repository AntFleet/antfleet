# Session handoff — pick up here

This file is the resume sheet for the next session. It's transient — delete it once Mission 4 is fully done and start a clean handoff for whatever follows.

**Last session ended:** 2026-05-17, after Mission 3 closed.
**Last commit:** `75ff270` (`feat(web): Mission 3 slice 3-6 — vercel.json cron schedule + close Mission 3`)
**Working tree:** clean (modulo this file committing alongside the slice).

---

## What's done

`AGENTS.md §4` has the full table — Missions 1 and 3 are complete. The end-to-end pipeline (webhook → 2-of-2 unanimous review → PR comment → finding lifecycle → daily sweep → closure receipts + reaction polling) is wired in code. **Two ops steps remain before the first scheduled cron run is meaningful** (these are not code, they're config — listed below).

## Ops debt to clear before the cron is fully live

Not required to start Mission 4 — Mission 4 is the landing page / receipts page, entirely separable from the cron. But the cron won't do useful work until these land. Do these next time you touch Vercel/Neon, regardless of whether Mission 4 has started.

1. **Apply pending Neon migrations**:
   ```bash
   pnpm -F @antfleet/web db:migrate
   ```
   Applies `0002_lush_nighthawk` (maintainer_reactions dedup unique index) + `0003_high_maggott` (reviews installation_id/owner/repo columns). Without these, the cron will silently no-op (loadSweepWork drops batches missing coord columns) or throw on `recordMaintainerReactions`.

2. **Set `CRON_SECRET` in Vercel project env**:
   ```bash
   openssl rand -hex 32 | tr -d '\n' | pbcopy   # generate and copy
   vercel env add CRON_SECRET production         # paste when prompted
   vercel env add CRON_SECRET preview            # same value
   ```
   Add to `apps/web/.env.local` by hand (do NOT `vercel env pull` — see Things to avoid). The route 500s without it.

3. **Backfill the M3-1 smoke row's repo coords** so it becomes sweepable (otherwise the only existing finding_status rows in Neon remain inert):
   ```sql
   UPDATE reviews
      SET installation_id = 132854945,
          owner = 'Augustas11',
          repo = 'krisskross_shops'
    WHERE review_id = '83e79770-1869-4331-8690-b534a531d327';
   ```

4. **Smoke-test the cron** once the above three land:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://<preview-url>/api/cron/sweep
   ```
   Expect 200 with `{swept, closed, reactionsRecorded, reviewsSkipped, errors, elapsedMs}`. Errors are per-batch and don't fail the request — inspect `errors[]` if anything looks off.

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
pnpm -F @antfleet/web dev
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
