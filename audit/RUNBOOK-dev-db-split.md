# RUNBOOK — Split dev DB off the prod Neon endpoint (T0.4)

> **CONFIDENTIAL — operator-only.** This file lives under the gitignored
> `audit/` directory by default. The Neon-branch creation and `.env.local`
> swap it describes are local-only and never need to be pushed. (If the
> file is ever force-added to a commit it enters git history visible to
> all repo collaborators — no credentials live in this runbook, so the
> blast radius is documentation only, but be deliberate about it.)

**Audit task:** Milestone 0 / T0.4.
**Status before:** `apps/web/.env.local`'s `DATABASE_URL` points at the prod
Neon compute endpoint (`ep-crimson-hall-aq6bfx9d`, database `neondb`). Dev and
prod share one DB. Every local dev `pnpm dev`, hand-run query, and
`apply-migration-*.ts --apply` writes against prod.
**Status after:** local dev points at a Neon **dev branch** forked from prod.
Prod compute is untouched; `.env.local` no longer resolves to the prod
endpoint hostname; Vercel project envs are unchanged.

---

## 0. Why this needs to land first

This split is a **prerequisite gate** for several other audit fixes. Apply
them only after the split is verified:

- **T1.4** — Repair or retire the migration mechanism. Any
  experimentation with `db:generate` / `db:migrate` / `db:push` against the
  current DB risks writing prod schema state. After the split, that
  experimentation can happen against the dev branch.
- **QW4** — Add the missing public-page indexes
  (`apps/web/db/migrations/0037_public_page_indexes.sql` or its renumbered
  equivalent). The runbook for QW4 says "do not apply"; the rationale is the
  shared DB. Once the split lands, the operator can `--apply` against the
  dev branch first, observe `EXPLAIN ANALYZE`, then promote to prod.
- **QW5** — The `apply-migration-*.ts` default-deny guard
  (`apps/web/db/migrations/safety.ts`) already shipped in this branch
  (replaces the stale `PROD_PATTERNS = ['neon-fulvous-zebra', 'solitary-dew-96858656']`
  list with an `ALLOW_PROD_APPLY=1` check). Re-evaluate the guard's
  ergonomics after the split: with a dev branch in `.env.local`, routine
  applies on the dev branch should NOT require `ALLOW_PROD_APPLY=1`. See
  §9 for the follow-up.

The Top-3-risks block in `audit/AUDIT-2026-06-13.md` calls this out as the
operational footgun behind H10/H11 — splitting dev off prod is the
substrate that lets the rest of the migration story stop being a data-loss
risk.

---

## 1. Pre-split safety checklist

Run these *before* touching the Neon UI. None of them mutates state.

1. **Confirm the current `DATABASE_URL` host.** From the repo root:
   ```bash
   grep -E '^DATABASE_URL=' apps/web/.env.local | sed -E 's/^DATABASE_URL=//' \
     | node -e 'process.stdin.on("data",d=>{try{console.log(new URL(d.toString().trim().replace(/^["'\'']|["'\'']$/g,"")).host)}catch(e){console.log("(unparseable)")}})'
   ```
   Expected output today: a hostname containing `ep-crimson-hall-aq6bfx9d`
   (the prod compute). If it doesn't contain that string, stop and
   re-read this runbook — your starting state isn't what this document
   assumes.

2. **Snapshot prod is implicit on Neon.** Neon keeps point-in-time
   recovery (PITR) on the parent branch — the default retention covers
   the last several days on the free/pro tier. Still: open the Neon
   console → `antfleet` project → Branches → confirm PITR is enabled
   on the prod branch (the parent you're about to fork from) and note
   the current LSN/timestamp in case rollback is needed.

3. **Confirm no migration is mid-apply.** Open every shell that has
   `apply-migration-*.ts` running; wait for them to finish. Migration
   applies are non-transactional across statements in some scripts
   (e.g. `apply-migration-0038.ts` runs each statement separately), so
   forking mid-apply would clone a half-applied schema. From the repo
   root:
   ```bash
   ps -ef | grep -E 'apply-migration|drizzle|pnpm.*db' | grep -v grep
   ```
   Output should be empty.

4. **Confirm no long-running review-worker / sweep is mid-write.**
   These run on Vercel, not your laptop, but if you've started the
   Next dev server locally (`pnpm --dir apps/web dev`) and let it
   serve cron endpoints, stop it now. The dev server uses the same
   `DATABASE_URL` as prod and could write through the fork moment.

5. **Capture the current `git rev-parse HEAD`** of the working tree
   you'll be running migrations against post-split. Useful if you need
   to bisect a "did the dev branch see this schema?" question later.

---

## 2. Create the Neon dev branch (UI walkthrough)

> Neon's UI labels change month-to-month. Treat the path below as the
> intent; if a label drifted, the equivalent action is always under
> *Branches* in the project sidebar.

1. Log in to <https://console.neon.tech/>.
2. Open the **antfleet** project (the one whose prod compute is
   `ep-crimson-hall-aq6bfx9d`).
3. Sidebar → **Branches** → **Create branch**.
4. Fill the form:
   - **Branch name:** `dev` (or `dev-<your-handle>` if multiple devs
     want isolated branches — the cost is negligible).
   - **Parent branch:** the current prod branch (the default branch;
     typically named `main` or `production` in the Neon project).
   - **Include data up to:** *Current point in time* (the default).
     This forks both schema and data as of "now", which is what you
     want for a dev-environment clone.
   - **Compute:** *Add a compute endpoint*. Pick **the smallest size
     available** (0.25 CU is enough for local dev), **enable
     autosuspend** (5 minutes is fine — the branch should sleep when
     you're not running queries), and **do not** add a read replica.
   - **Pooled connection:** ensure "Pooler enabled" is checked. The
     web app uses `@neondatabase/serverless` which goes through the
     pooled hostname (`-pooler` suffix). Without it, connections from
     the dev server will exhaust direct-connection quota fast.
5. Click **Create branch**. Neon provisions in a few seconds.

After creation, the branch detail page shows two connection-string
forms. Both will have a hostname of the shape
`ep-<two-words>-<id>-pooler.<region>.aws.neon.tech` (for the pooled
form) — emphatically **not** `ep-crimson-hall-aq6bfx9d-pooler.…`,
which is prod.

---

## 3. Grab the dev-branch connection string

In the branch detail page → **Connection Details**:

1. **Database:** select `neondb` (same DB name as prod; the fork
   carries it over).
2. **Role:** select the same role you use in prod (typically
   `neondb_owner`).
3. **Connection type:** **Pooled connection**. The web app and every
   `apply-migration-*.ts` script use `@neondatabase/serverless`'s
   `neon(url)` HTTP helper. The HTTP transport will work with either
   the pooled or direct hostname, but the pooled form is the
   prod-parity choice (Vercel's `DATABASE_URL` points at the pooled
   host) and avoids exhausting the direct-connection budget if a
   future migration adds a long-lived `Pool`/`Client` (TCP) consumer.
   Always include `?sslmode=require` in the query string.
4. Copy the connection string. It will look like:
   ```
   postgres://<role>:<password>@ep-<words>-<id>-pooler.<region>.aws.neon.tech/neondb?sslmode=require
   ```
   Treat it as a bearer credential. Do not paste it into
   `.env.example`, Slack, or any tracked file.

---

## 4. Update `apps/web/.env.local`

This is the **only** place to swap the URL. Do **not** touch:

- the Vercel project env vars (those must stay on the prod URL — the
  deployed app reads them at runtime),
- `apps/web/.env.example` (tracked; never holds real URLs),
- any other env file.

Open `apps/web/.env.local` in your editor and replace the
`DATABASE_URL=` line with the dev-branch string from §3. Keep
everything else (GitHub App key, CRON_SECRET, OPTIN_HMAC_SECRET,
ANTFLEET_OPS_GH_TOKEN, …) unchanged.

If you keep a `.env.local.prod-backup` for the moments when you
deliberately need to point at prod (e.g. running a one-off
prod-data query), save the previous prod URL there now. Otherwise
keep the prod URL only in the Neon UI / Vercel project envs.

---

## 5. Verify the split (no-write probes)

Each probe below either reads only or runs a dry-run. None of them
applies a migration.

### 5.1 — `apply-migration` dry-run shows the dev host

`apps/web/db/migrations/safety.ts`'s `assertSafeToApply()` echoes
`Target host: <host>` on every run, including dry-run. Pick the most
recently shipped migration script as a probe (the one whose
post-apply state you most recently saw on prod), e.g.:

```bash
pnpm --dir apps/web exec tsx db/migrations/apply-migration-0038.ts
```

> Note: this is a **dry run** — there is no `--apply` flag. The script
> prints `Target host: <hostname>` followed by `--- DRY RUN (pass
> --apply to execute) ---` and the SQL body, then exits 0 without
> touching the DB. (`safety.ts:46-53` makes the `apply=false` path
> permissive — it does not require `ALLOW_PROD_APPLY`.) This guarantee
> applies only to appliers that route through `assertSafeToApply()` from
> `db/migrations/safety.ts`; older scripts under `apps/web/scripts/`
> that pre-date the safety helper may write on import — verify any
> chosen probe imports `safety` (`grep -l "from.*safety" apps/web/db/migrations apps/web/scripts`) before running it.

Expected printed host: the dev-branch hostname from §3 (some variant
of `ep-<words>-<id>-pooler.<region>.aws.neon.tech`).

Failure mode — if it prints `ep-crimson-hall-aq6bfx9d-pooler…`, your
`.env.local` edit didn't take effect. Common causes: the
`dotenv.config({ path: join(selfDir, "../../.env.local") })` line
resolves relative to the script's own directory, so the file must
literally be at `apps/web/.env.local` (not `apps/.env.local`, not
repo-root `.env.local`). Also confirm you saved the file.

### 5.2 — Same probe under `apps/web/scripts/`

The older appliers under `apps/web/scripts/` resolve `.env.local`
through a slightly different relative path
(`dotenv.config({ path: join(selfDir, "../.env.local") })` in
`apply-migration-0026.ts`). Repeat the probe with one of those:

```bash
pnpm --dir apps/web exec tsx scripts/apply-migration-0026.ts
```

Same expected output: `Target host: ep-<…dev…>…`. This catches the
case where both env files exist and one is stale.

> Caveat: only probe `scripts/` files that import `assertSafeToApply`
> from `db/migrations/safety.ts` — the dry-run-without-`--apply`
> guarantee only holds via that helper. Confirm with
> `grep -l "from.*safety" apps/web/scripts/apply-migration-*.ts` before
> running a scripts/-side applier as a probe.

### 5.3 — Data sanity (dev branch sees the cloned snapshot, not live prod)

Pick a prod-only-mutable table whose row count drifts slowly. Good
candidates:

- `reviews` — grows on every PR review; if your dev branch's count
  matches prod at fork time, it's the clone. After a few hours, prod
  will have advanced.
- `agent_findings` — same pattern.

Run a count against the dev branch via the same `DATABASE_URL` your
edited `.env.local` now holds. The probe `cd`s into `apps/web` first
so the relative `.env.local` path resolves deterministically (do not
rely on `pnpm --dir`'s subprocess CWD behaviour — it varies by pnpm
version, and a CWD-at-repo-root run would silently miss the file and
either crash on `DATABASE_URL!` or, worse, fall through to whatever
URL is already exported in the operator's shell):

```bash
cd apps/web && pnpm exec tsx -e '
  import { neon } from "@neondatabase/serverless";
  import * as dotenv from "dotenv";
  import { join } from "node:path";
  // override: true so the file always wins over a stale shell DATABASE_URL.
  dotenv.config({ path: join(process.cwd(), ".env.local"), override: true });
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not loaded from apps/web/.env.local — re-check the file path.");
    process.exit(1);
  }
  const h = new URL(process.env.DATABASE_URL).host;
  if (h.includes("ep-crimson-hall-aq6bfx9d")) {
    console.error("STOP: DATABASE_URL still resolves to the prod compute (" + h + "). The .env.local swap (step 4) did not take effect, or a shell-exported DATABASE_URL is shadowing the file. Refusing to query.");
    process.exit(1);
  }
  const sql = neon(process.env.DATABASE_URL);
  const r = await sql`SELECT count(*)::int AS n FROM reviews` as any[];
  console.log("reviews row count (dev branch):", r[0]?.n);
  console.log("connected host:", h);
'
```

Expected: a count that matches the prod `reviews` count at the
moment you forked (within a few seconds of drift). Connected host
must contain the dev branch's id, not `ep-crimson-hall-aq6bfx9d`.

The `connected host:` line is the **definitive** check: it must
contain the dev branch's id, not `ep-crimson-hall-aq6bfx9d`. The
row-count cross-check against the Neon UI's prod-branch SQL Editor
(`SELECT count(*) FROM reviews;`) is a sanity-confirm-the-fork-data
step — at fork time the two should match exactly. Don't read
divergence-over-time as a misconfiguration signal: prod review
volume is bursty, and counts may legitimately stay flat for hours.
If the `connected host:` log is correct, you're on the dev branch
regardless of what the row count does.

### 5.4 — Web app boots against the dev branch

```bash
pnpm --dir apps/web dev
```

Open <http://localhost:3000/disagreements> (or any public page that
loads `reviews`). Cross-check a few headlines against
<https://www.antfleet.dev/disagreements> — they should match at fork
time and diverge as prod accumulates new reviews.

---

## 6. Rollback

If any §5 probe fails, or you want to scrub the dev branch:

1. **Revert `.env.local`.** Restore the prod
   `DATABASE_URL=postgres://…@ep-crimson-hall-aq6bfx9d-pooler.…/neondb?sslmode=require`
   line (from your `.env.local.prod-backup` if you kept one, else
   from the Neon UI → prod branch → Connection Details).
2. **Re-run §5.1** to confirm `Target host:` now echoes the prod
   hostname again.
3. **Delete the dev branch (optional).** Neon UI → Branches →
   the `dev` branch you created → **Delete**. Neon will warn about
   data loss on the branch; that's fine, you forked from prod and
   the prod branch is untouched. The compute endpoint goes with the
   branch — no separate cleanup needed.
4. **Notify any other operator** who pulled the dev branch's
   connection string that it's gone, so they can re-fork or re-point.

Prod is *not* in the rollback path — the entire procedure above only
mutates a fork. The only thing that could touch prod is if step 3
(delete) is invoked against the *parent* branch by mistake; the
Neon UI requires typing the branch name to confirm deletion, which
is the guard. Re-read the branch name before clicking through.

---

## 7. What this runbook does NOT do

- It does **not** create the Neon dev branch automatically. That is an
  intentional operator action — the Neon API token has org-wide
  write scope and the audit refuses to script anything that could
  fork the wrong project under the wrong parent.
- It does **not** change Vercel project environment variables. Prod
  must keep reading the prod URL.
- It does **not** include any operator step that touches
  `.env.example`. That file is tracked and must never carry a real
  connection string. The comment block pointing operators to this
  runbook was added in the same commit as this file; a fresh
  checkout already contains it. No operator action against
  `.env.example` is required to land the split.
- It does **not** apply any migration. Per the audit, T1.4/QW4/QW5
  follow-ups all wait until after this split is live.

---

## 8. Operator action checklist (the actual TODO)

The deliverable of T0.4 is this runbook + the `.env.example`
comment. The remaining operator work is:

- [ ] Read §0–§4 of this runbook.
- [ ] Run the §1 safety checklist.
- [ ] Create the Neon dev branch via §2.
- [ ] Capture the pooled connection string via §3.
- [ ] Swap `apps/web/.env.local` per §4.
- [ ] Run all §5 probes; all must pass.
- [ ] Notify yourself (or future you, via memory) that T1.4 / QW4 /
      QW5 are now unblocked, and gate them on this checklist being
      complete.

---

## 9. Follow-ups to schedule AFTER the split lands

- **Re-evaluate `apps/web/db/migrations/safety.ts`'s
  `ALLOW_PROD_APPLY=1` gate.** With a dev branch in `.env.local`,
  routine applies on the dev branch should not require the env var
  — the gate exists specifically because dev and prod shared one
  DB. Options to consider (do NOT implement as part of T0.4 — these
  are notes for whoever picks up T1.4/QW5 next):
  - Keep the gate but match on hostname: only require
    `ALLOW_PROD_APPLY=1` when the resolved host equals the prod
    compute hostname. Hostname-pinned guards have a known failure
    mode (compute endpoints can be renamed) — pin to the Neon
    *branch id* (stable across compute renames) if the Neon API
    surface exposes it cheaply.
  - Keep the gate as-is for belt-and-braces and accept the minor
    friction of exporting the env var when applying to the dev
    branch.
- **Re-evaluate testcontainers vs Neon-dev-branch for integration
  tests** (audit H8 — money-movement SQL never hits real
  Postgres). With the dev branch live, an integration test that
  forks-a-branch-per-test-run becomes feasible (Neon supports
  programmatic branch creation via API). Tradeoffs vs the existing
  testcontainers-Postgres setup: branch-per-run gives identical
  schema + extension parity with prod but adds an external
  dependency and Neon API rate limits to the test path.
- **Document the dev branch's existence somewhere persistent.** A
  one-line note in user memory (this audit is confidential, so
  not in any tracked file) — "dev branch on Neon antfleet project,
  name `dev`, forked YYYY-MM-DD" — so the next operator session
  doesn't re-fork by accident.
- **Re-check `dev` and `prod` divergence weekly.** A long-lived dev
  branch drifts from prod as prod accumulates new reviews/findings;
  for catching prod-state-dependent bugs locally, periodically
  reset the dev branch (Neon UI → Branches → `dev` → **Reset to
  parent**). This is non-destructive of the prod parent.
