# DECISION — sting's home (audit T2.5, fixes H12 structurally)

**Date:** 2026-06-13
**Branch:** `audit/m2-high-leverage`
**Status:** Decided — **Option B (extract / retire in-tree path)**. The
extraction has already happened upstream; the remaining work is local
hygiene plus a follow-up tracked separately on the sting repo.

---

## Context

`sting/` sits inside the AntFleet checkout at `/Users/augstar/projects/antfleet/sting`,
hidden from `git status` only by a **machine-local** `.git/info/exclude` entry
(line 12 of `.git/info/exclude`). On disk it is ~43 MB and ~34 K LOC of `.mjs`
(102 files). Its `package.json` chains a sizeable verify suite (`verify:spec001`,
`verify:spec002`, `verify:spec004`; `verify-spec-004-schema.mjs` alone is 9,062
lines, 486 `assert()` + 182 `assertRejects()`). It ships its own crons via
`sting/vercel.json` (`/api/cron/retire-closed-contests` daily, two more
`*/10 * * * *` jobs touching dispatch + poll for track runs).

### Facts established this task

1. **`sting/` is a nested git repo with its own remote.**
   `git -C sting remote -v` → `origin https://github.com/AntFleet/sting.git`.
   `HEAD` is `0f23f71` on `main` (2026-05-31), up-to-date with `origin/main`
   (per `git -C sting status -sb`: `## main...origin/main`). The working tree
   on this operator's laptop is NOT clean — `git -C sting status` lists
   untracked files (`.omc/`, several `docs/sting-launch-video-*.md`,
   `handoff/SPEC-004-GAP-CLOSURE-GOAL.md`, multiple `specs/SPEC-003*` and
   `specs/AUDIT_SPEC_003_*`). Step 2 below preserves them.

2. **It is NOT in the antfleet workspace.**
   `pnpm-workspace.yaml` lists only `apps/*`. Root `package.json` has zero
   `sting` references. `git ls-files sting` is empty in the parent repo
   (corroborated verbatim by commit `5635d6a` log: *"AntFleet/sting is its own
   separate repo … `git ls-files sting` is empty"*).

3. **It has zero coupling to the parent.**
   Two complementary greps were run from `sting/` (excluding `node_modules`),
   covering both single- and double-quoted import strings used by sting's
   `.mjs` files:
   ```bash
   grep -rEn "from ['\"]\.\./" --include='*.mjs' --include='*.js' --include='*.ts' .
   grep -rEn "from ['\"]\.\./\.\./\.\."  --include='*.mjs' --include='*.js' --include='*.ts' .
   ```
   The first lists 36 matches, all intra-sting (`api/**` → `backend/**`, or
   intra-`backend/`). The second — which is the only pattern that could
   escape `sting/` — returns zero matches. `sting/AGENTS.md:3-5` makes this
   an explicit project invariant: *"Keep it independent from
   `/Users/augstar/projects/antfleet` unless the operator explicitly asks to
   merge or copy work into AntFleet."*

4. **A sting CI job in this repo was added and then explicitly removed.**
   - `aa251c5 "ci: gate apps/web typecheck + next build and add sting job"` — added it
   - `5635d6a "ci: fix lint + drop sting job from CI (separate repo)"` — removed it,
     with this reasoning in the commit body verbatim:
     > "the round-2 audit prompt suggested a sting CI job, but AntFleet/sting is
     >  its own separate repo — it sits next to apps/web locally but is NOT
     >  vendored into AntFleet/antfleet (`git ls-files sting` is empty). The CI
     >  runner's `working-directory: sting` could never resolve. Drop the job entirely."

5. **The dead `.git/info/exclude` entry is operator-private.**
   `sting/` (and `.omx/`, `.codex/`, `.agents/`, `.tmp/`) live in `.git/info/exclude`
   on this laptop only — they are NOT tracked by `.gitignore`, so a fresh clone
   plus an accidental `git add sting/` would silently swallow 34 K LOC of an
   unrelated repo. That is the residual H12 sharp edge once the CI angle is
   moot.

---

## Option A — bring sting under the pnpm workspace + add the CI job

Concrete steps if A is taken. Listed for completeness; NOT recommended (see
**Decision** below) and NOT executed by this commit.

A.1. **Vendor sting into the antfleet tree.** From antfleet repo root:
```bash
# Remove the local-only hide so the files become visible to git.
sed -i.bak '/^sting\/$/d' .git/info/exclude
# Remove the tracked .gitignore rule that this audit added under Option B.
# (See `/sting/` line in .gitignore, added by audit T2.5.) Otherwise `git add`
# silently skips the directory. Required FIRST commit on the Option A branch.
sed -i.bak '/^\/sting\/$/d' .gitignore
git diff -- .gitignore  # sanity: confirms `/sting/` line removed
git add .gitignore
# Drop the nested .git so the files become trackable by the parent repo.
# (Operator must first ensure the canonical github.com/AntFleet/sting repo
#  has every commit currently in ./sting/.git — destructive otherwise.)
git -C sting log --oneline -1            # capture the head SHA
rm -rf sting/.git sting/.vercel sting/node_modules sting/.omc sting/.omx
git add sting                # now succeeds because the ignore rule is gone
# At this point ~102 .mjs files and ~34 K LOC join the antfleet history.
```

A.2. **Add `sting` to the pnpm workspace.** Exact patch:
```diff
--- a/pnpm-workspace.yaml
+++ b/pnpm-workspace.yaml
@@
 packages:
   - "apps/*"
+  - "sting"
```
Note: `sting/package.json` uses `npm`-shaped deps (no pnpm catalog), so a
`pnpm install` would generate a new lockfile that overrides
`sting/package-lock.json`. The operator must decide whether to keep
`package-lock.json` (and exclude `sting` from `pnpm install`) or migrate sting
to pnpm. This is a real switching cost.

A.3. **Add a sting CI job** (re-introducing exactly what `5635d6a` deleted).
Exact patch against `.github/workflows/ci.yml`:
```diff
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -33,3 +33,16 @@ jobs:
       # Reintroduce this step once that route is fixed; until then,
       # typecheck above is the deployability proxy.
       - run: pnpm --dir apps/web exec tsx scripts/x402-live-smoke.ts --mode verify --skip-on-missing-creds
+
+  sting:
+    runs-on: ubuntu-latest
+    steps:
+      - uses: actions/checkout@v6
+      - uses: actions/setup-node@v6
+        with:
+          node-version: 26
+      - run: sudo apt-get update && sudo apt-get install -y sqlite3
+      - run: npm ci
+        working-directory: sting
+      - run: npm test
+        working-directory: sting
```

A.4. **Establish a sync policy for AntFleet/sting.** The canonical sting repo
at `github.com/AntFleet/sting` would now be a *fork point in time*. Options
the operator must pick from before A is viable:
- A.4.a — Archive `AntFleet/sting`, send all future sting work as PRs against
  the antfleet repo. Disruption: any pending sting PRs/branches must be
  rebased and re-targeted.
- A.4.b — Maintain bidirectional sync via `git subtree pull/push`. Disruption:
  ongoing operator overhead, and the H12 surface (untyped `.mjs`,
  string-interpolated SQL) would now block antfleet CI on every sting commit.

A.5. **Local validation before merge:**
```bash
pnpm install                # confirm the workspace resolves
( cd sting && npm test )    # `npm run verify:spec001 && verify:spec002 && verify:spec004` — must be green
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

### Why Option A is not recommended

- `sting/AGENTS.md:3-5` is an explicit project invariant against merging sting
  into antfleet: *"Keep it independent from `/Users/augstar/projects/antfleet`
  unless the operator explicitly asks to merge or copy work into AntFleet."*
- The CI job in A.3 is *exactly* the one added in `aa251c5` and deleted in
  `5635d6a` four hours later — it cannot resolve `working-directory: sting`
  while `git ls-files sting` is empty, so re-adding it requires landing A.1
  first (which is the strategically expensive step).
- sting has zero `from "../"` imports into antfleet (`grep` performed),
  meaning the coupling argument that would justify a monorepo is absent. The
  two products communicate only through HTTP / adapter contracts per
  `sting/AGENTS.md:9-38`.
- A.4 forces a sync-policy decision the audit cannot make on the operator's
  behalf.

---

## Decision

**Option B (extract).** Confirmed: sting already lives at
`github.com/AntFleet/sting`. CI for sting is sting's own responsibility, not
antfleet's. The in-tree path is a stale local convenience that should be
retired, and the local-only `.git/info/exclude` foot-gun should be closed.

### What this fixes vs. what it doesn't

| Slice of H12 | Resolved by this decision | How |
|---|---|---|
| "Untyped 34 K LOC `.mjs` ships with no CI" — **as part of antfleet** | YES | Out of antfleet's scope: sting is a different product/repo. Quoting `5635d6a` makes the boundary explicit. |
| "Test suite runs only manually" — **for sting itself** | NO | Tracked as a follow-up against `AntFleet/sting`. See *Follow-up* below. Not appropriate to fix from inside antfleet. |
| "Nested-git hidden via local exclude → 34 K LOC appears as untracked on a fresh clone" | YES | Retire the in-tree path: either delete the directory or move it outside the antfleet checkout; add a tracked `.gitignore` line so the exclude no longer relies on a per-laptop file. |
| "String-interpolated SQL in `sting/backend/lib/sql-helpers.mjs`" | NO | Sting-repo concern. |

---

## Concrete execution steps for Option B

### Step 1 — Land this decision now (this PR — what audit T2.5 produces)

1.1. Write this decision doc (`audit/DECISION-sting-home.md`) — done by this commit.

1.2. Add tracked `.gitignore` entries so the foot-gun does not rely on a
per-laptop `.git/info/exclude`. Exact patch (already implemented in this commit):

```diff
--- a/.gitignore
+++ b/.gitignore
@@ -21,3 +21,10 @@ examples/antseed-corpus/apps/

 .vercel
 .env.vercel*
+
+# sting is a separate product repo (github.com/AntFleet/sting) that sometimes
+# sits side-by-side on operator laptops at ./sting. It must NEVER be vendored
+# into this repo. The historical `.git/info/exclude` entry is machine-local and
+# would not protect a teammate who runs `git add .` on a fresh clone. See
+# audit/DECISION-sting-home.md (T2.5).
+/sting/
```

Verification after this lands:
- `git ls-files sting` continues to print nothing.
- `git status` with a fresh clone that happens to have a sibling `sting/`
  checkout does NOT list 34 K LOC of untracked files.

### Step 2 — Operator-side cleanup (out of scope for this PR; runbook only)

Either path is fine; the operator picks. Both end the same state.

**Pre-flight checks — run ALL of these and read them before continuing.**
The local `./sting` working tree on the audit operator's laptop is NOT clean
(see Facts §1). `sting/.gitignore` also hides `.vercel/`, `.env*`,
`backend/local/`, `*.sqlite*`, `cases/`, and `node_modules/` — so the
plain `status` output understates what would be destroyed by `rm -rf`.
```bash
git -C sting remote -v               # must show: origin https://github.com/AntFleet/sting.git
git -C sting status -sb              # confirm "## main...origin/main" with no "ahead"
git -C sting status --porcelain      # tracked + untracked changes; non-empty on the
                                     # audit laptop today.
git -C sting status --ignored --porcelain \
  | grep -E '^!! (\.vercel|\.env|backend/local|cases|.*\.sqlite)' || true
                                     # ALL of these are operator-laptop only —
                                     # never push, never on origin. Treat any
                                     # match as REQUIRING copy-aside before 2.b.
```

**2.a — Move sting out of the antfleet checkout (recommended; safe with a
dirty *and* ignored-files-present working tree because nothing is deleted).**
```bash
# from antfleet repo root
mv sting ~/projects/sting            # any sibling path works; pick what suits the laptop
# verify the AntFleet/sting remote and that BOTH tracked-untracked and ignored
# state survived the move (crucial for the .vercel/ + .env + sqlite + cases set).
git -C ~/projects/sting remote -v                           # -> origin https://github.com/AntFleet/sting.git
git -C ~/projects/sting status --porcelain                  # same set of paths as before the mv
git -C ~/projects/sting status --ignored --porcelain | head # .vercel/, .env*, sqlite, etc. all present
# Vercel deployments keep working: `sting/.vercel/project.json` (the project
# linkage) moves with the directory, no relink required.
# Remove the now-stale local exclude line so it cannot mask a future accidental clone.
sed -i.bak '/^sting\/$/d' .git/info/exclude
```

**2.b — Or delete the local working tree if a separate checkout exists elsewhere.**
**Pre-conditions (ALL must hold; if any one fails, STOP and use 2.a):**
- Pre-flight `git -C sting status --porcelain` returns empty.
- Pre-flight `git -C sting status --ignored --porcelain | grep -E '^!! (\.vercel|\.env|backend/local|cases|.*\.sqlite)'` returns empty (or those artifacts have been copied to the separate checkout via `cp -a`).
- Pre-flight: no local-only refs exist beyond what's already on `origin`. Run:
  ```bash
  # Branches not on any remote — would be destroyed.
  git -C sting for-each-ref --format='%(refname:short)' refs/heads \
    | while read b; do
        git -C sting branch -r --contains "$b" | grep -q . || echo "LOCAL-ONLY BRANCH: $b"
      done
  # Tags not pushed.
  git -C sting push --dry-run --tags origin 2>&1 | grep -v 'Everything up-to-date' || true
  # Stashes.
  git -C sting stash list
  ```
  On the audit laptop this prints nothing (only `main`, no extra branches,
  no tags, no stashes — verified). If any of those three checks emits output,
  push/copy that work first or use 2.a.
- A canonical clone of `github.com/AntFleet/sting` at a known path is independently confirmed (`git -C <other-path> rev-parse --verify HEAD` matches `0f23f71` or newer on origin/main).
```bash
# Pre-conditions above must hold. Otherwise STOP and use 2.a.
rm -rf sting                         # destroys the operator-laptop copy only
sed -i.bak '/^sting\/$/d' .git/info/exclude
```

In either case, the tracked `.gitignore` rule keeps a *future* sibling
`sting/` from re-introducing the H12 surface.

### Step 3 — Crons / credentials migration

No migration is required between antfleet and sting; sting was never part of
antfleet's deployment surface. The mapping is:

| Artifact | Lives in | Action under Step 2 |
|---|---|---|
| Cron schedule (`retire-closed-contests`, `dispatch-track-runs`, `poll-track-runs`) | `sting/vercel.json` (tracked in `AntFleet/sting`) | Moves with the directory in 2.a; survives 2.b because it's on origin. |
| Vercel project linkage | `sting/.vercel/project.json` (gitignored) | Path 2.a preserves it via `mv`. Path 2.b deletes it — Vercel project is fine on the dashboard side, but `vercel ...` from CLI in a new checkout requires `vercel link` to re-attach. |
| Vercel env vars (sting prod creds) | Vercel dashboard, not in repo | Untouched by either path. |
| Local `.env` / `.env.local` (operator dev creds) | `sting/.env*` (gitignored) | Path 2.a preserves. Path 2.b destroys — must be copied aside (see Step 2 pre-flight). |
| Local sqlite DB(s) | `sting/*.sqlite*` + `sting/backend/local/` (gitignored) | Path 2.a preserves. Path 2.b destroys — ephemeral dev state, but document the loss. |
| Bounty case fixtures | `sting/cases/` (gitignored) | Path 2.a preserves. Path 2.b destroys if unique. |

There is no antfleet → sting credential handover and no antfleet → sting cron
handover; antfleet does not own any sting credentials.

### Step 4 — Follow-ups (tracked as separate work against AntFleet/sting)

These are sting-repo concerns; this audit does not push to that repo, and
they do not block T2.5. Capture them as work to file there:

- 4.a. Add a `.github/workflows/ci.yml` to `AntFleet/sting` that runs
  `sqlite3` install + `npm ci` + `npm test` (mirroring the deleted job from
  `aa251c5`). Without this, sting's substantial verify suite still only runs
  manually — H12's testing slice survives on the sting side.
- 4.b. Address the string-interpolated SQL helpers in
  `sting/backend/lib/sql-helpers.mjs` (H12 audit note) on the sting side.
- 4.c. Consider type-via-JSDoc on sting's hot paths (cron handlers, dispatch
  layer) — also a sting-side concern.

---

## Acceptance check against the T2.5 spec

| Acceptance criterion | Met by |
|---|---|
| "Decision doc lays out two options with concrete steps" | Sections **Decision** + **Concrete execution steps** above, plus the verbatim quote of why option A is moot under current state. |
| "Recommend one based on coupling" | Recommendation is B, justified by **Facts established this task** §3 (zero `from "../` escapes from `sting/`) and `sting/AGENTS.md:3-5`. |
| "Check whether sting imports anything from the parent" | Performed. `grep -rEn 'from "\.\./|from "\.\./\.\./|from "\.\./\.\./\.\./' sting/` returns only intra-sting imports. Result documented in Fact §3. |
| "If A: implement workspace/CI wiring now" | N/A — recommendation is B. The full A runbook (vendor + workspace YAML + CI YAML + sync policy) is laid out in the **Option A** section above so the operator can flip the decision if needed. |
| "If B: step-by-step extraction runbook" | **Concrete execution steps for Option B** §§Step 1–4: Step 1 (in-repo cleanup) implemented now; Steps 2–4 are runbook-only operator actions, not executed by this commit. |
| "The decision doc must be CONCRETE: exact files to add/modify, exact CI YAML diff if A, exact commands if B" | Option A section: exact `pnpm-workspace.yaml` and `.github/workflows/ci.yml` diffs inlined. Option B section: exact `.gitignore` diff (implemented this commit), exact `mv` / `rm -rf` / `sed` commands for Step 2. |
| "M2 milestone summary can quote the chosen option verbatim" | The milestone summary can quote: *"Option B (extract). sting already lives at github.com/AntFleet/sting; antfleet now carries a tracked `.gitignore` rule (`/sting/`) so a sibling `sting/` checkout can no longer be silently re-added to antfleet history. Retiring the existing operator-laptop copy and adding CI on the sting side are runbook-only follow-ups (see DECISION-sting-home.md §§ Step 2, Step 4)."* |
