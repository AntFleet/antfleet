# Fix prompt — SPEC-001 v0.5 audit partials → v0.6 launch-clean

Operator-paste prompt to close the 3 partial closures from
`specs/SPEC-001-impl-v1-audit.md` (multi-agent narrow audit, 2026-05-29).

The v1 fix pass closed 28/31 prior findings (90%) and preserved all 3
load-bearing invariants. Three closures landed PARTIAL:

  P1.2 (MAJOR) — Cross-wallet cooldown test uses same wallet on both sides;
                 the cross-wallet semantic (entire point of AC-6 per spec
                 line 1400) is not actually exercised.
  P1.5 (MAJOR) — Migration 0028 test uses fakeSql() that returns canned
                 "expected" state regardless of executed SQL; SQL typos,
                 syntax errors, or constraint-name mismatches would slip
                 through.
  PartB (MAJOR-ish) — run.mjs passes `authorizationWindowSeconds: 600` into
                 `@x402/evm@2.13.0`, but `EvmSchemeConfig` typedefs accept
                 only `{rpcUrl?}` — the option is silently ignored. 600s
                 window currently holds only because server's
                 `paymentRequirements.maxTimeoutSeconds=600` matches.
                 Belt-only defense; spec/code drift.

Audit verdict was **READY TO SHIP**; these are explicitly v0.6 follow-up
patches, NOT launch-blockers. Recommend shipping v0.6 before real
mainnet traffic to close the drift before it gets observed.

Scope:
- **Spec edit**: `specs/SPEC-001-aeon-x402.md` v0.5 → v0.6 (changelog + Part B clarification)
- **3 code fixes**:
  - P1.2: ~5 lines in `apps/web/app/api/v1/review/x402/route.test.ts`
  - P1.5: ~30-50 lines in `apps/web/db/migrations/0028.test.ts` (and maybe `package.json`)
  - Part B: ~10-30 lines in `antfleet/aeon-skills` PR #1's run.mjs (pushed to existing PR branch)

Run in **Codex CLI** (continuity with v1 fix pass). Expected duration:
~30-60 min.

Paste everything between `=== BEGIN PROMPT ===` and `=== END PROMPT ===`
into a fresh Codex session rooted at `/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are closing the 3 partial closures from the SPEC-001 v0.5
implementation fix audit. The audit report at
specs/SPEC-001-impl-v1-audit.md returned verdict READY TO SHIP but
flagged 3 partials worth fixing before mainnet traffic.

Targets:
- specs/SPEC-001-aeon-x402.md  v0.5 → v0.6  (changelog + Part B note)
- apps/web/app/api/v1/review/x402/route.test.ts  (P1.2 — real cross-wallet)
- apps/web/db/migrations/0028.test.ts  (P1.5 — real Postgres apply)
- antfleet/aeon-skills PR #1 :: pr-review-antfleet-x402/run.mjs  (Part B window fix)

## Critical constraints (unchanged from v1 fix)

**1. Dual-rail isolation invariant (FR-E1).** review-pipeline.ts MUST
remain byte-unchanged. No new rail-aware branching in the pipeline.

**2. Aeon-gate removability (FR-C3).** X402_REQUIRE_AEON_CONTEXT=false
short-circuit MUST continue to work.

**3. Channel-rail no-regression (AC-7).** All 782 tests across 93 files
MUST continue to pass.

**4. Source-of-truth alignment.** When verifying a fix, read the source
file FIRST. The PartB fix specifically requires checking
@x402/evm@2.13.0 typedefs.

**5. No `--no-verify` on commits.** Pre-commit hooks exist.

**6. Git identity.** `antfleet-ops` account for all writes. Do NOT
switch git config. For the antfleet/aeon-skills PR push, ensure
`gh auth status` shows antfleet-ops active; if `gh auth switch -u antfleet-ops`
reports invalid tokens but git/gh operations still work (Codex saw this
in the v1 fix pass), proceed — the operations succeeded.

**7. No commits to this repo from you.** Operator commits the 3 code
changes as one v0.6 group. EXCEPTION: the antfleet/aeon-skills PR #1
fix MUST be committed + pushed to the existing PR branch by you, since
it's on an external repo.

## Operator decisions baked in as defaults

| # | Partial | Default |
|---|---|---|
| 1 | P1.2 fix | **Change second-wallet address** in the cross-wallet test case so it differs from the first wallet. Trivial. |
| 2 | P1.5 fix | **Wire real Postgres testcontainer if dependency budget allows**; if `@testcontainers/postgresql` is a hard sell, fall back to using the project's existing Vercel Postgres / Neon / sqlite test infra. If NEITHER exists, document the limitation explicitly + downgrade AC-11 in spec to "schema-shape assertion via apply/verify functions" with operator-gated end-to-end smoke. Do NOT silently leave fakeSql as the gate. |
| 3 | PartB window fix | **Add runtime assertion in run.mjs**: after fetching paymentRequirements from the 402 response, assert `maxTimeoutSeconds <= 600` before signing the authorization. Log warning if server advertises a longer window. Document in run.mjs comment that server-side `maxTimeoutSeconds` is the primary defense; client-side `authorizationWindowSeconds` is a no-op against @x402/evm@2.13.0. (Hand-rolling EIP-3009 signing in run.mjs to bypass @x402/evm's auto-generation is a future hardening item, NOT in v0.6 scope.) |

If a default is impossible (e.g. P1.5 testcontainer install genuinely
breaks the build), STOP and document.

## Required reading (in order)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-impl-v1-audit.md
   — section "Suggested fix order" and the per-finding closure rows
   for P1.2, P1.5, Part B. These describe exactly what's partial.

2. /Users/augstar/projects/antfleet/apps/web/app/api/v1/review/x402/route.test.ts
   — find the AC-6 / cooldown test case and identify where both wallets
   are currently the same.

3. /Users/augstar/projects/antfleet/apps/web/db/migrations/0028.test.ts
   — read the fakeSql() implementation; understand what it returns
   regardless of executed SQL.

4. /Users/augstar/projects/antfleet/apps/web/package.json
   /Users/augstar/projects/antfleet/apps/web/vitest.config.ts (or
   similar test config)
   — check if any existing test infrastructure uses ephemeral Postgres.
   Search for: `@testcontainers`, `pg-mem`, `Postgres.js`, `globalSetup`,
   or `setupFiles`. Document what's available.

5. https://github.com/antfleet/aeon-skills/pull/1 (current Part B PR)
   — fetch contents:
     gh pr view 1 --repo antfleet/aeon-skills --json files,headRefName
     gh pr diff 1 --repo antfleet/aeon-skills > /tmp/aeon-skills-pr1.diff
   — read run.mjs to find the `authorizationWindowSeconds: 600` call site.

6. @x402/evm v2.13.0 typedefs (or whatever pinned version):
     cd /tmp && rm -rf check-x402-evm
     npm pack @x402/evm@2.13.0 --pack-destination /tmp/check-x402-evm 2>&1 | tail -3
     tar -xzf /tmp/check-x402-evm/*.tgz -C /tmp/check-x402-evm
     # Look for EvmSchemeConfig export:
     grep -rn "EvmSchemeConfig" /tmp/check-x402-evm/package/dist/
   — confirm the audit's claim that `authorizationWindowSeconds` is not
   in the accepted options.

## Fixes — apply in order

### Fix 1 — P1.2 cross-wallet cooldown test

Location: `apps/web/app/api/v1/review/x402/route.test.ts`

Find the test case that asserts cross-wallet cooldown caching (AC-6 +
P1.2 coverage). The audit found both wallets in the test are currently
identical, so the cross-wallet semantic isn't actually exercised.

Apply the smallest possible fix:
1. Identify the existing wallet constant used in the test setup.
2. Add a SECOND wallet constant (different EIP-55 checksummed address —
   any valid hex address; use `0x` followed by 40 distinct hex chars
   that aren't the first wallet).
3. Update the test case so:
   - Wallet W1 creates the original review (existing setup)
   - Wallet W2 (the new constant) submits the cooldown request
4. Add assertions:
   - 200 status (not 202 — cached hit)
   - Response body has the cached job's data
   - `deps.verifyPayment` NOT invoked for W2's request
   - `deps.createJob` NOT invoked for W2's request

The wallet difference is what makes this AC-6 (cross-wallet), not
AC-3 (same-wallet idempotency). Both AC-3 and AC-6 should exist as
separate cases — if Codex collapsed them, separate them.

After the fix, run:
  pnpm --dir apps/web test apps/web/app/api/v1/review/x402/route.test.ts
And confirm green.

### Fix 2 — P1.5 migration 0028 real apply test

Location: `apps/web/db/migrations/0028.test.ts`

Current state: uses fakeSql() that returns canned "expected" results
regardless of executed SQL. Therefore SQL typos, syntax errors, or
constraint name mismatches slip through.

Step 1 — investigate existing test DB infrastructure (per required
reading #4). Three possibilities:

**Option A — Existing test DB harness exists.** If you find existing
test utilities for real DB queries (e.g. a `testDb` helper, a vitest
globalSetup that spins up Postgres, or use of `@vercel/postgres`'s
test mode), wire 0028.test.ts into that harness:
1. Set up a fresh DB at migration head 0027 in `beforeAll`.
2. Seed 2 review_jobs rows (one `status=complete`, one `status=queued`,
   both with `failure_mode` from existing channel-rail enum to verify
   migration doesn't break them).
3. Programmatically invoke `applyMigration0028({ apply: true })` (the
   importable function Codex already exposes).
4. Query `information_schema.columns` to assert all expected columns,
   types, nullability, defaults, and CHECK constraints.
5. Re-run apply to confirm idempotency (exit 0, no errors, no duplicate
   index creation).
6. Tear down in `afterAll`.

**Option B — No existing harness; install @testcontainers/postgresql.**
If the project has no Postgres test infra:
1. Install: `pnpm --dir apps/web add -D @testcontainers/postgresql`
   (or whatever package manager + workspace convention the repo uses).
2. Add Docker-required note to the test file's leading comment.
3. Wire as in Option A but with testcontainers spinning up a fresh
   Postgres for each test run.
4. Skip the test if Docker is unavailable in CI (use `describe.skipIf`
   pattern or similar) — note this in implementation notes; failure mode
   should be "test skipped" not "test silently passes".

**Option C — Both above are blocked.** If installing testcontainers
breaks the build (Docker unavailable in CI, dependency conflicts), OR
no existing harness exists AND testcontainers can't be added:
1. Keep fakeSql but make it STRICT — return values based on actual SQL
   parsed/inspected (regex match), not canned constants. This catches
   syntax-level drift but not semantic.
2. Add explicit comment in 0028.test.ts:
   `// LIMITATION: This test does not run against a real Postgres engine. Schema-shape drift caught via SQL string inspection only. Pre-mainnet operator MUST run apply-migration-0028.ts --apply against staging DB and verify columns via psql before AC-1 mainnet gate.`
3. Add spec change to AC-11 (in spec edit step below) downgrading it
   to "schema-shape assertion via apply/verify functions; end-to-end
   apply verified via operator gate on staging."

Default: try Option A first. If no existing harness, attempt Option B
(install testcontainers). Fall back to Option C only if both blocked.
Document which option was chosen in implementation notes.

After the fix, run:
  pnpm --dir apps/web test apps/web/db/migrations/0028.test.ts
And confirm green.

### Fix 3 — Part B run.mjs window enforcement

Location: `antfleet/aeon-skills` PR #1 :: `pr-review-antfleet-x402/run.mjs`

Audit confirmed `@x402/evm@2.13.0`'s `EvmSchemeConfig` accepts only
`{rpcUrl?}` — the `authorizationWindowSeconds: 600` option is silently
ignored. The 600s defer-settle window currently holds ONLY because the
server's 402 response advertises `maxTimeoutSeconds=600`. If the server
ever advertises a longer window (config drift, env override, etc.) the
client would happily sign an authorization with the longer validity,
defeating the defer-settle refund model.

Step 1 — clone the PR branch and switch to it:

```
cd /tmp && rm -rf aeon-skills-window-fix
gh repo clone antfleet/aeon-skills /tmp/aeon-skills-window-fix
cd /tmp/aeon-skills-window-fix
# Get the PR's head branch name:
BRANCH=$(gh pr view 1 --json headRefName --jq .headRefName)
git checkout $BRANCH
```

Step 2 — apply the runtime assertion. Find the section of run.mjs
where the 402 response is processed (likely the x402 client's payment
selection callback or where `paymentRequirements` is read). Add:

```javascript
// SPEC-001 v0.6: defer-settle defense — server-side maxTimeoutSeconds
// is the PRIMARY enforcement of the EIP-3009 validity window.
//
// The client-side authorizationWindowSeconds: 600 option passed to
// @x402/evm is silently ignored by @x402/evm@2.13.0 (EvmSchemeConfig
// accepts only {rpcUrl?}). Future hardening: hand-roll EIP-3009
// signing in this runner to set validAfter/validBefore explicitly.
const MAX_AUTH_WINDOW_SECONDS = 600;
function assertAuthorizationWindowAcceptable(paymentRequirements) {
  const advertised = Number(paymentRequirements?.maxTimeoutSeconds);
  if (!Number.isFinite(advertised) || advertised <= 0) {
    throw new Error(
      `Refusing to sign authorization: server did not advertise a valid maxTimeoutSeconds (got ${paymentRequirements?.maxTimeoutSeconds}).`
    );
  }
  if (advertised > MAX_AUTH_WINDOW_SECONDS) {
    throw new Error(
      `Refusing to sign authorization: server advertised maxTimeoutSeconds=${advertised}, exceeds client ceiling ${MAX_AUTH_WINDOW_SECONDS}s. Suspected server misconfiguration or version skew.`
    );
  }
  // Optional: also warn if server advertised noticeably less than expected
  if (advertised < MAX_AUTH_WINDOW_SECONDS * 0.5) {
    console.warn(
      `[x402] Server advertised short window: maxTimeoutSeconds=${advertised}s. Reviews may fail if work exceeds ${advertised}s.`
    );
  }
}
```

Call `assertAuthorizationWindowAcceptable(paymentRequirements)` BEFORE
the x402 client signs the authorization. The exact integration point
depends on whether you're using `x402HTTPClient` directly or a wrapped
fetch pattern — read the existing run.mjs to find the right hook.

If the x402 client's API doesn't expose a pre-sign callback that
returns paymentRequirements, the fallback is to do an unauthenticated
HEAD/GET probe of the 402 response first, assert, then perform the
real authorized fetch. This is heavier but works regardless of client
API.

Step 3 — commit + push to the existing PR branch:

```
git add pr-review-antfleet-x402/run.mjs
git commit -m "fix: enforce server-advertised authorization window ceiling

@x402/evm@2.13.0 silently ignores authorizationWindowSeconds in
EvmSchemeConfig. Without this assertion the client would sign any
window the server advertises, defeating the defer-settle refund
model if server config drifts.

Adds a runtime check that refuses to sign authorizations with
maxTimeoutSeconds > 600s (the SPEC-001 v0.6 client ceiling).
Documents that server-side maxTimeoutSeconds is the primary
defense; future hardening is to hand-roll EIP-3009 signing.

Closes SPEC-001 v0.5 audit Part B partial closure.

Co-Authored-By: Codex (GPT-5) <noreply@openai.com>"

git push
```

Step 4 — add a one-line comment to the PR explaining the fix:

```
gh pr comment 1 --repo antfleet/aeon-skills --body "Pushed v0.6 fix: runtime assertion enforces server-advertised maxTimeoutSeconds <= 600s ceiling. Closes Part B partial closure from SPEC-001 v0.5 audit."
```

### Fix 4 — Spec v0.6 changelog

Location: `specs/SPEC-001-aeon-x402.md`

Bump version line: `**Version:** 0.6 (<today's date>, v0.5 audit partials closure)`

Add v0.6 changelog block above v0.5:

```
**Change log v0.6:**
- P1.2 closure: AC-6 cross-wallet cooldown test now uses two distinct wallet addresses; the cross-wallet semantic is actually exercised.
- P1.5 closure: Migration 0028 test now applies against [REAL POSTGRES via testcontainers / EXISTING TEST HARNESS / DOWNGRADED to schema-shape + operator gate — pick whichever applies based on Fix 2 outcome].
- Part B closure: pr-review-antfleet-x402/run.mjs now asserts server-advertised maxTimeoutSeconds <= 600s before signing authorizations. Documents that server-side is primary defense; client-side authorizationWindowSeconds is a no-op against @x402/evm@2.13.0. Future hardening: hand-roll EIP-3009 signing.
```

If Fix 2 took Option C (downgrade AC-11), ALSO modify AC-11 in § 8:
- Update "How to verify" to: "Schema-shape assertion via importable apply/verify functions through SQL string inspection (apps/web/db/migrations/0028.test.ts). Real end-to-end apply verified via operator gate before AC-1 mainnet: run `node apply-migration-0028.ts --apply` against staging DB and verify columns via `psql -c '\\d review_jobs'`."

If Fix 2 took Option A or B, AC-11 stays as-is.

### Final cleanup pass

After all 4 fixes applied:

1. Run full test suite:
   pnpm --dir apps/web test
   Confirm 782 + N (where N is the test count delta from Fix 1/Fix 2 changes).
   Channel-rail tests still green.

2. Run typecheck + lint:
   pnpm --dir apps/web typecheck
   pnpm --dir apps/web lint

3. Verify spec v0.6 changelog references all three partials.

4. Verify the antfleet/aeon-skills PR #1 branch has the new commit (git
   log --oneline -3 in /tmp/aeon-skills-window-fix should show your
   commit on top).

## Process

1. Read required materials.

2. Apply Fix 1 → Fix 2 → Fix 3 → Fix 4 in order.

3. Run verification suite at end.

4. Print a 250-word handback summary to stdout listing:
   - Version bump applied (v0.5 → v0.6)
   - Per-partial closure status (P1.2, P1.5, PartB)
   - Which Fix 2 option was taken (A real harness / B testcontainers / C downgrade) + reason
   - Test count delta (before vs after)
   - antfleet/aeon-skills PR #1 commit URL
   - Spec v0.6 lines added
   - Any deviations from defaults
   - Operator confirmation needed (especially if Option C taken — operator must verify staging migration apply before mainnet AC-1)

5. Do NOT commit `apps/web/` or `specs/` changes — operator commits the
   v0.6 group locally. DO commit + push the antfleet/aeon-skills PR
   change since it's on an external repo and the operator can't easily
   review uncommitted external-repo work.

## What NOT to do

- Do NOT modify review-pipeline.ts (FR-E1 invariant — byte-frozen).
- Do NOT add new test files beyond what's needed for the 3 partials.
- Do NOT make additional fixes beyond the 3 partials + spec bump.
- Do NOT collapse AC-3 and AC-6 into the same test case.
- Do NOT use `--no-verify` on commits.
- Do NOT switch git config.
- Do NOT use `Augustas11` gh account.
- Do NOT commit the apps/web/ or specs/ changes — operator commits.
- Do NOT pick a different P1.5 option silently if the default Option A
  is blocked — document the blocker in handback and request operator
  decision before falling back.

## Expected size of diff

| Area | Files | LOC estimate |
|---|---|---|
| Fix 1 (P1.2 cross-wallet) | 1 file modified | ~10 LOC |
| Fix 2 Option A | 1 file modified | ~30-50 LOC |
| Fix 2 Option B | 1 file modified + 1 dep added | ~40-60 LOC + package.json |
| Fix 2 Option C | 1 file modified + spec edit | ~10-20 LOC |
| Fix 3 (Part B run.mjs) | 1 file modified, 1 commit pushed | ~25 LOC |
| Fix 4 (spec v0.6) | 1 file modified | ~15 LOC |

**Total in apps/web (Options A/B):** ~50-70 LOC
**Total in apps/web (Option C):** ~30 LOC + spec downgrade
**Total in external (antfleet/aeon-skills):** ~25 LOC + 1 commit pushed
**Total in specs/:** ~15-30 LOC

If diff exceeds these targets, you've expanded scope. Stop + audit.

When done, print the 250-word handback summary and stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist (~5 min):

1. **Spec v0.6 changelog** — references all 3 partials + which P1.5 option was taken
2. **Fix 1 (P1.2)** — test now uses two distinct wallets; cross-wallet semantic actually exercised
3. **Fix 2 (P1.5)** — which option landed? If C (downgrade), confirm operator commits to running manual staging apply before AC-1 mainnet
4. **Fix 3 (Part B)** — `gh pr view 1 --repo antfleet/aeon-skills` shows new commit on top of branch
5. **Test count** — 782 + N green
6. **Invariants** — all 3 still PRESERVED (no review-pipeline.ts changes; no channel-rail test changes)

Commit groupings (operator runs):

```bash
# Local v0.6 group
git add apps/web/app/api/v1/review/x402/route.test.ts \
        apps/web/db/migrations/0028.test.ts \
        specs/SPEC-001-aeon-x402.md
# Plus apps/web/package.json + pnpm-lock.yaml if Fix 2 Option B
git commit -m "x402: close v0.5 audit partials → v0.6 launch-clean

P1.2: AC-6 cross-wallet cooldown test now uses two distinct wallets,
exercising the cross-wallet semantic AC-6 actually tests.

P1.5: Migration 0028 test now [REAL APPLY / DOWNGRADED — fill in
based on Codex's Option choice]. [If C: pre-mainnet operator gate
documented in AC-11.]

Part B: run.mjs (antfleet/aeon-skills PR #1 branch) gains runtime
assertion that refuses to sign authorizations when server-advertised
maxTimeoutSeconds > 600s. Closes Part B partial closure; server-side
remains primary defense.

Spec bumped to v0.6.

Co-Authored-By: Codex (GPT-5) <noreply@openai.com>"
```

## Sequencing after v0.6 lands

1. **Commit + push local v0.6** (operator)
2. **antfleet/aeon-skills PR #1** — verify Codex's new commit landed cleanly; smoke-test the skill locally; self-merge (or wait for outside review)
3. **aaronjmars/aeon PR #270** — ping Aaron for merge
4. **OQ-1 resolution** — Aaron confirms HMAC secret distribution mechanism
5. **OQ-5 resolution** — operator provisions CDP API keys in production Vercel env
6. **AC-1a Sepolia smoke** — runs automatically on next CI build (P2.6 already wired this)
7. **AC-1 mainnet smoke** — manual operator gate; live USDC test
8. **If Option C taken in Fix 2**: operator runs manual staging migration apply + verify before AC-1 mainnet
9. **Live** — partnership goes operational

## Total spec corpus state after v0.6

```
specs/
├── SPEC-001-aeon-x402.md                    v0.6 (canonical)
├── SPEC-001-audit.md                        round-1 (Codex GPT-5, v0.1)
├── SPEC-001-v0-2-audit.md                   round-2 (Claude Opus, v0.2)
├── SPEC-001-v0-3-audit.md                   round-3 narrow (Claude Opus, v0.3)
├── SPEC-001-impl-audit.md                   impl audit (workflow, e4475b8)
├── SPEC-001-impl-v1-audit.md                v1 fix audit (workflow, v0.5)
├── AUDIT_SPEC_001_PROMPT.md                 full audit framework
├── AUDIT_SPEC_001_V0_3_NARROW_PROMPT.md     narrow audit framework
├── FIX_SPEC_001_V0_1_PROMPT.md              v0.1 → v0.2 spec fix
├── FIX_SPEC_001_V0_2_PROMPT.md              v0.2 → v0.3 spec fix
├── FIX_SPEC_001_IMPL_V1_PROMPT.md           e4475b8 impl fix (31 findings)
├── FIX_SPEC_001_IMPL_V2_PROMPT.md           v0.5 → v0.6 partials closure (THIS PROMPT)
├── BUILD_SPEC_001_IMPL_PROMPT.md            implementation prompt
└── README.md                                index
```

After v0.6 + operational gates clear → **SPEC-001 partnership ships live to aeon users.**

Critical path remaining: ~30-60 min of Codex work (this fix) + ~hours of operator-side OQ resolution + ~5 min of Sepolia smoke + ~10 min of mainnet smoke.

Want me to also draft the narrow re-audit prompt for v0.6 (would verify the 3 partial closures actually closed), or skip directly to operational gates?