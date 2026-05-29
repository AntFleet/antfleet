# Narrow audit prompt — SPEC-001 v0.6 partial-closure verification

Operator-paste prompt for the narrow re-audit of SPEC-001 v0.6. Scope is
intentionally restricted to verifying the 3 partial closures from the v1
fix audit actually closed cleanly + sanity-check the 3 load-bearing
invariants still hold.

**Why narrow.** The v0.5 impl audit returned READY TO SHIP with 3
partials. The v0.6 fix prompt addresses exactly those 3. No new
substantive work to audit; just closure verification + regression.

**Cross-model.** v0.6 fix was applied by Codex. Run this narrow audit
with Claude for cross-model coverage.

Expected duration: ~15-25 min (vs ~45-60 min for full audit).

Paste everything between the markers into a fresh Claude Code session
rooted at `/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are running a NARROW re-audit of SPEC-001 v0.6 to verify that the
3 partial closures from the v0.5 implementation fix audit actually
closed cleanly. This is NOT a full audit — scope is restricted to:

1. P1.2 cross-wallet cooldown test closure
2. P1.5 migration 0028 test closure (which Option A/B/C was taken, and is
   it adequate?)
3. Part B run.mjs window-enforcement closure (commit pushed to
   antfleet/aeon-skills PR #1)
4. Spec v0.6 changelog + alignment
5. Regression sanity: 3 load-bearing invariants still hold

Audit reports for context:
- /Users/augstar/projects/antfleet/specs/SPEC-001-impl-v1-audit.md
  — the v0.5 audit that flagged the 3 partials (READY TO SHIP verdict)
- /Users/augstar/projects/antfleet/specs/FIX_SPEC_001_IMPL_V2_PROMPT.md
  — the fix prompt that prescribed each closure

You return your audit report at:
  /Users/augstar/projects/antfleet/specs/SPEC-001-impl-v2-audit.md

You are NOT here to find new findings beyond regressions in the
changed areas. Do NOT re-evaluate sections that weren't touched by
the v0.6 patch unless you suspect a cross-section regression.

## Critical constraints

**1. Closure-verification is the primary task.** Each of the 3 partial
findings has a specific fix prescribed in FIX_SPEC_001_IMPL_V2_PROMPT.md.
Verify the fix landed. "Closed" means the spec/code matches the fix
prescription; "partial again" means the fix landed incompletely; "open"
means the fix didn't land.

**2. Regression check is the secondary task.** Spot-check that the
v0.6 changes didn't break anything in unchanged areas. The 3
invariants (FR-E1, FR-C3, AC-7) MUST still hold.

**3. No scope drift.** This is a closure audit, not a fresh full
audit. Do NOT introduce new findings about content that existed
unchanged from v0.5. If you find concerns in pre-existing content,
note as QUESTIONS for a future round.

**4. P1.5 Option-taken assessment.** The fix prompt offered three
options (A real harness / B testcontainers / C downgrade) for the
migration test. Identify which Codex took and grade whether it's
adequate for closure:
- Option A or B → CLOSED if real Postgres apply runs in the test
- Option C → CLOSED if AC-11 was downgraded in spec + operator gate
  documented, OTHERWISE PARTIAL (downgrade alone without spec change
  is not closure)

## Required reading (in order)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-impl-v1-audit.md
   — re-read the 3 partials section: P1.2 details, P1.5 fakeSql
   caveat, Part B authorizationWindowSeconds: 600 silent-ignore.

2. /Users/augstar/projects/antfleet/specs/FIX_SPEC_001_IMPL_V2_PROMPT.md
   — the prescriptive fix. Each closure has a specific expected
   shape (test asserts, SQL fixture, runtime assertion).

3. /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md (v0.6)
   — read the v0.6 changelog block. Verify it references P1.2, P1.5,
   Part B closures by name. If Option C was taken on P1.5, verify
   AC-11 § 8 wording was downgraded as prescribed.

4. /Users/augstar/projects/antfleet/apps/web/app/api/v1/review/x402/route.test.ts
   — find the cross-wallet cooldown test case (P1.2 fix lives here).
   Verify two distinct wallet addresses are used and the assertions
   actually exercise the cross-wallet semantic.

5. /Users/augstar/projects/antfleet/apps/web/db/migrations/0028.test.ts
   — find which Option was taken (real harness / testcontainers /
   fakeSql + downgrade). Read the implementation. Grade adequacy.

6. /Users/augstar/projects/antfleet/apps/web/package.json
   — if @testcontainers/postgresql was added, verify it's there as a
   devDependency.

7. antfleet/aeon-skills PR #1 — fetch the head commit:
     gh pr view 1 --repo antfleet/aeon-skills --json commits | jq '.commits[-1]'
     gh pr diff 1 --repo antfleet/aeon-skills | tail -100
   — verify a NEW commit was pushed for the Part B window fix.
   Read run.mjs to verify the runtime assertion exists.

8. Optional: confirm @x402/evm@2.13.0 still has the silent-ignore
   issue (or whatever pinned version Part B uses):
     cd /tmp && rm -rf check-x402-evm-v2
     npm pack @x402/evm@<pinned-version> --pack-destination /tmp/check-x402-evm-v2 2>&1 | tail -3
     tar -xzf /tmp/check-x402-evm-v2/*.tgz -C /tmp/check-x402-evm-v2
     grep -rn "EvmSchemeConfig" /tmp/check-x402-evm-v2/package/dist/
   — confirm Codex didn't claim to fix this by pinning a different
   version that doesn't exist.

## Closure verification per partial

### Partial 1: P1.2 cross-wallet cooldown test

Prescribed fix:
- Two distinct wallet constants in the test
- W1 creates review; W2 (different) submits cooldown request
- 200 status, body mirrors cached job
- deps.verifyPayment NOT invoked for W2
- deps.createJob NOT invoked for W2

Verify by reading route.test.ts. If the test now uses two distinct
EIP-55 checksummed addresses AND the assertions match the prescribed
list, mark CLOSED. If the wallets are still identical, mark OPEN
(the entire point of P1.2 wasn't addressed).

### Partial 2: P1.5 migration test

Prescribed fix (any of three options):

Option A — wire into existing test DB harness, real Postgres apply.
Verify: 0028.test.ts imports and runs applyMigration0028 against a
real DB; queries information_schema.columns; asserts caller_wallet,
payment_rail, x402_pay_to + other columns present with correct types;
asserts no review_jobs_failure_mode_check; asserts idempotency on
re-apply.

Option B — install @testcontainers/postgresql. Verify: package.json
has the dev dep; test spins up testcontainer; tests as in Option A
plus a describe.skipIf or equivalent for Docker-unavailable CI.

Option C — keep fakeSql but make strict + downgrade AC-11. Verify:
- 0028.test.ts has explicit limitation comment
- AC-11 in spec § 8 has new wording about schema-shape assertion +
  pre-mainnet operator gate
- v0.6 changelog mentions the downgrade

Grade:
- Option A or B with real apply → CLOSED
- Option C with all three sub-requirements → CLOSED (with QUESTION
  flagged about operator-gate enforcement)
- Option C without spec downgrade → PARTIAL AGAIN
- Codex silently kept fakeSql without any of the three options →
  OPEN (re-flag as MAJOR; spec invariant violated)

### Partial 3: Part B run.mjs window enforcement

Prescribed fix:
- New commit pushed to antfleet/aeon-skills PR #1 branch
- run.mjs has assertAuthorizationWindowAcceptable() (or equivalent
  function name) that refuses to sign when maxTimeoutSeconds > 600
- Function called BEFORE x402 client signs the authorization
- Comment in run.mjs documents server-side as primary defense
- PR comment posted referencing the v0.6 fix

Verify:
1. gh pr view 1 --repo antfleet/aeon-skills --json commits — should
   show at least one new commit on top of the original PR commits,
   authored by antfleet-ops, with message referencing v0.6 / Part B
   / authorization window.
2. gh pr diff 1 --repo antfleet/aeon-skills — read the diff for the
   new commit; verify the assertion function is present and called
   before any sign-flow.
3. Grade adequacy: does the assertion actually prevent signing if
   the server advertises a longer window? Read the integration point
   carefully.

CLOSED if all three sub-checks pass. PARTIAL if commit pushed but
assertion missing/weak. OPEN if no new commit on PR.

## Regression sanity checks

### R-1. FR-E1 dual-rail isolation
- Verify apps/web/lib/review-pipeline.ts is STILL byte-unchanged vs
  e4475b8:
    git diff e4475b8 -- apps/web/lib/review-pipeline.ts
- Expected: zero lines of diff.
- Fail: CRITICAL regression (re-open the closed v1 invariant finding).

### R-2. FR-C3 aeon-gate removability
- Verify apps/web/lib/x402/aeon-gate.ts X402_REQUIRE_AEON_CONTEXT=false
  short-circuit still present at line ~22.
- Fail: CRITICAL.

### R-3. AC-7 channel-rail no regression
- Verify ONLY apps/web/lib/paywall changes are the prescribed
  cost_cap_exceeded removal:
    git diff e4475b8 -- apps/web/lib/paywall
- Expected: minimal diff matching v0.5 + nothing new in v0.6.
- Fail: re-flag at original severity.

### R-4. Spec v0.6 changelog references all 3 closures
- Read v0.6 changelog block in spec.
- Pass: P1.2, P1.5, Part B all mentioned by name with one-line
  closure description.
- Fail: MAJOR (incomplete documentation; future readers can't
  reconcile v0.5 audit findings to closures).

### R-5. Test count delta makes sense
- Codex's reported test count from v0.6 should be 782 + delta where
  delta is +0 (Fix 1/Fix 2 modified existing tests, not added new
  ones) OR +1 if a new explicit cross-wallet test case was added.
- Pass: counts within expected range (782-786).
- Fail: count drift = QUESTION (investigate before MAJOR).

### R-6. No scope creep in v0.6 fix
- Verify the v0.6 diff scope matches the prescribed ~80-120 LOC in
  apps/web + ~25 LOC in antfleet/aeon-skills + ~30 LOC in spec.
- Run: git diff e4475b8 --stat
- If dramatically larger (say >500 LOC), flag as QUESTION — Codex
  may have included unrelated fixes.

## Severity rubric (this audit)

  CRITICAL — A partial-closure prescribed fix didn't land (OPEN status
             on any of P1.2/P1.5/Part B). OR an invariant regression
             (R-1/R-2/R-3 fails).

  MAJOR    — A prescribed fix landed only partially. OR R-4 fails
             (spec changelog incomplete).

  MINOR    — Cosmetic gap, minor framing issue.

  QUESTION — Auditor uncertain whether closure is adequate (e.g. Option
             C taken — does operator gate get enforced in practice?).

## Output format

Write to:
  /Users/augstar/projects/antfleet/specs/SPEC-001-impl-v2-audit.md

Structure:

  # SPEC-001 v0.6 Narrow Re-Audit Report
  Auditor: <model name + version>
  Spec audited: SPEC-001 v0.6 (commit <hash if known, else "uncommitted">)
  v0.5 audit reference: specs/SPEC-001-impl-v1-audit.md
  Audit completed: <UTC timestamp>
  Audit scope: NARROW (3 partial closures + 3 invariant regression checks)

  ## TL;DR verdict

  READY TO SHIP | NEEDS REVISION

  One paragraph: closure rate (3/3 expected), regression check pass/fail,
  any new findings, operator gates remaining (if Option C taken on P1.5).

  ## Partial closure verdicts

  | Partial | v0.5 severity | v0.6 status | Notes |
  |---|---|---|---|
  | P1.2 cross-wallet | MAJOR | CLOSED/PARTIAL/OPEN | ... |
  | P1.5 migration | MAJOR | CLOSED/PARTIAL/OPEN (with Option chosen) | ... |
  | Part B run.mjs | MAJOR-ish | CLOSED/PARTIAL/OPEN | ... |

  ## Regression check results

  | Check | Pass/Fail | Notes |
  |---|---|---|
  | R-1 review-pipeline.ts byte-frozen | ... | ... |
  | R-2 aeon-gate short-circuit intact | ... | ... |
  | R-3 channel-rail diff prescribed-only | ... | ... |
  | R-4 v0.6 changelog complete | ... | ... |
  | R-5 test count sane | ... | ... |
  | R-6 no scope creep | ... | ... |

  ## P1.5 option taken

  Identify whether Codex took Option A / B / C and grade adequacy.
  If Option C: document the operator gate that MUST run before AC-1
  mainnet smoke.

  ## Part B PR head commit reference

  Quote the commit hash + message Codex pushed to antfleet/aeon-skills PR #1.

  ## New findings (if any)

  Should be zero or near-zero for a clean v0.6.

  ### CRITICAL (N)
  ### MAJOR (N)
  ### MINOR (N)
  ### QUESTIONS (N)

  ## Ship recommendation

  If 3/3 CLOSED + 6/6 regression checks PASS + 0 new findings: READY
  TO SHIP. Operator proceeds to commit + merge external PRs + OQ
  resolution + AC-1a Sepolia smoke + AC-1 mainnet smoke.

  If anything partial/open: list the narrow re-fix needed (should be
  ≤30 lines).

## What NOT to do

  - Do NOT re-audit unchanged sections beyond the 6 regression checks.
  - Do NOT modify the spec or code.
  - Do NOT run ACs (no implementation gate; this is closure verification).
  - Do NOT flag pre-existing v0.5-era concerns as new findings.

When done, print a 150-word summary to stdout:
  - Verdict
  - 3/3 closure rate
  - 6/6 regression pass
  - P1.5 option taken
  - Part B PR commit hash
  - Any new findings
  - Ship recommendation in one line

Then stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist (~3 min):

1. **3/3 closures CLOSED** — anything less = blocker
2. **6/6 regression checks PASS** — any FAIL = invariant violation, re-fix
3. **P1.5 option** — if Option C, confirm you'll run the manual staging
   apply gate before mainnet AC-1
4. **Part B PR commit** — verify Codex pushed it to the right branch

If READY TO SHIP:
- Commit v0.6 group locally
- Self-merge antfleet/aeon-skills PR #1
- Ping Aaron on aaronjmars/aeon PR #270
- Resolve OQ-1 + OQ-5
- AC-1a Sepolia smoke auto-runs on CI
- Manual staging migration apply (if Option C)
- AC-1 mainnet smoke
- **Live**

If NEEDS REVISION (unlikely for v0.6 — it's a tight scope):
- Trivial fix prompt (probably ≤30 lines)
- Apply
- Re-narrow-audit
- Ship

## Total flow now

Once Codex finishes v0.6 fix and Claude finishes this narrow audit
(both ~30-60 min combined), the partnership is launch-ready pending
the operational OQ resolution gates. No more spec/audit cycles needed
unless something surprising surfaces.

Want me to spawn this audit automatically as soon as Codex's v0.6 fix
completes (i.e., set up the trigger now)? Or wait for explicit go-ahead
after you review Codex's handback?