# Session handoff — pick up here

This file is the resume sheet for the next session. It's transient — delete it once Mission 3 is fully done and start a clean handoff for Mission 4.

**Last session ended:** 2026-05-17, after Mission 3 slice 3-5.
**Last commit:** `58043da` (`feat(web): Mission 3 slice 3-5 — sweep orchestrator + cron route`)
**Working tree:** clean (modulo this file + AGENTS.md §4 row flip committing alongside it).

---

## What's done

`AGENTS.md §4` has the full table. One-line summary: **Mission 1 complete, Mission 3 through slice 3-5 of 6 — only the cron schedule remains.** The orchestrator route is live at `/api/cron/sweep`; everything that needs to run on a schedule is now reachable via one `Authorization: Bearer ${CRON_SECRET}` GET.

## What's next: Mission 3 slice 3-6 (cron schedule + secret provisioning)

Two trivial deliverables and one verification pass:

1. **`vercel.json`** at repo root with:
   ```json
   {
     "crons": [{ "path": "/api/cron/sweep", "schedule": "0 6 * * *" }]
   }
   ```
   - 6am UTC daily matches AGENTS.md §10 ("Daily cron polls each posted-PR comment for new reactions").
   - If the repo already has a `vercel.json`, merge the `crons` array rather than replacing.

2. **`CRON_SECRET`** Vercel env var:
   - `vercel env add CRON_SECRET production` — paste a random 32+ char value (e.g. `openssl rand -hex 32`).
   - Repeat for `preview` and `development` if smoke-testing in those environments.
   - Pull into `.env.local` for local manual triggering: **do NOT** use `vercel env pull` (overwrites manual keys — see "Things to avoid"); add the same value to `.env.local` by hand.

3. **Migrate Neon to schema 0003**:
   - `pnpm -F @antfleet/web db:migrate` against the production Neon DB. This runs `0002_lush_nighthawk` (dedup unique index from slice 3-4) AND `0003_high_maggott` (installation_id/owner/repo columns from slice 3-5).
   - The 4 existing M3-1 smoke `finding_status` rows on review `83e79770-1869-4331-8690-b534a531d327` will now have null installation_id/owner/repo on their parent review row — the sweep silently skips them (loadSweepWork drops batches missing any of the three).
   - To make the smoke row sweepable, backfill manually:
     ```sql
     UPDATE reviews
        SET installation_id = 132854945,
            owner = 'Augustas11',
            repo = 'krisskross_shops'
      WHERE review_id = '83e79770-1869-4331-8690-b534a531d327';
     ```

4. **End-to-end smoke**:
   - Deploy to Vercel (`git push` to a branch; preview env is fine for first verification).
   - `curl -H "Authorization: Bearer $CRON_SECRET" https://<preview-url>/api/cron/sweep`
   - Expect 200 with `{ swept: 4, closed: 0|1|..., reactionsRecorded: 0+, reviewsSkipped: 0, errors: [], elapsedMs: N }`.
   - If `errors` is non-empty, inspect Vercel function logs — every error has a `scope`/`reviewId`/`findingId` triple.

5. **Trigger one manual cron** in Vercel dashboard → Crons → Run now (preview env). Verify the function executes, returns 200, and writes any new rows to `maintainer_reactions` / closes via `finding_status.status='closed'`.

**Estimated effort**: 20-30 minutes. The code lifting is done.

## After 3-6

Mission 3 done. Delete `HANDOFF.md`, update `AGENTS.md §4` to mark Mission 3 complete, then start the Mission 4 handoff. Mission 4 (landing page + public receipts page + data policy) is the customer-visible counter §18.2 names.

## Resume sequence

```bash
cd /Users/augstar/projects/antfleet
git log --oneline -25                            # full session arc
pnpm install                                     # if root touched
pnpm -w build                                    # rebuild root dist/
pnpm -F @antfleet/web test                       # baseline: 90 passing
pnpm -F @antfleet/web db:migrate                 # apply 0002 + 0003 to Neon
pnpm -F @antfleet/web dev                        # local smoke
```

## State you might have forgotten

- **Smee client may or may not still be running**. `pgrep -f smee-client` to check. Restart: `pnpm dlx smee-client --url https://smee.io/PCgyaSg2iXGWP66P --target http://localhost:3000/api/github/webhook`.
- **Test fixtures** (not committed; pull from `.env.local`):
  - GitHub installation id: `132854945`
  - Test repo: `Augustas11/krisskross_shops` PR #1
  - PR head SHA used in smoke: `1ee2fd99f3b12d724e3850126662fdc08237cc28`
  - Review id with 4 open findings: `83e79770-1869-4331-8690-b534a531d327` (`pr_comment_id=4467353797`) — needs coord backfill (see above) to be sweepable.
- **Vercel project**: `augstar-8472s-projects/antfleet-web`, linked.
- **Neon**: `neon-fulvous-zebra`, project id `solitary-dew-96858656`, schema head at `0003_high_maggott`. **Two migrations pending against Neon**: 0002 (dedup unique index) + 0003 (reviews coord cols). Run `db:migrate` before slice 3-6 smoke.
- **Local manual cron trigger**: `curl -H "Authorization: Bearer <secret>" http://localhost:3000/api/cron/sweep` against `pnpm -F @antfleet/web dev` works once `CRON_SECRET` is in `apps/web/.env.local`.

## Things to avoid

- **Don't pull Vercel env directly into `apps/web/.env.local`** — it overwrites manually-added keys. Use `vercel env pull .env.vercel.tmp --yes` and merge by hand. (Burned by this once in slice 3-2.)
- **Don't symlink `apps/web/.env.local`** — Vercel's auto-pull on integration add writes through the symlink. Lost the GitHub App PEM that way; recovered from conversation history.
- **Don't forget to migrate Neon before invoking the cron** — `recordMaintainerReactions` requires the 0002 dedup constraint; `loadSweepWork` requires the 0003 coord columns. Without 0003, every batch returns rows with null `installation_id` and the sweep silently no-ops.
- **Don't change the route from GET to POST** — Vercel cron calls `GET /<path>`. The handler is `export async function GET(...)`. If you flip it, the cron will 405.

## When you finish a slice

1. `pnpm -F @antfleet/web typecheck && pnpm -F @antfleet/web test && pnpm -F @antfleet/web build && pnpm -w test`
2. Commit with the `Mission 3 slice 3-X` prefix matching prior commits.
3. Update `AGENTS.md §4`'s Mission 3 table — flip the next row from `—` to `✓` with the new commit hash.
4. Once Mission 3 is fully done (3-6 committed): delete this file (`rm HANDOFF.md`) and update `AGENTS.md §4` to reflect Mission 3 complete, then start a clean handoff for Mission 4.
