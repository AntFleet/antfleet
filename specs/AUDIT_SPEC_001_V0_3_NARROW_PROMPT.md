# Narrow re-audit prompt — SPEC-001 v0.3 round-3 closure verification

Operator-paste prompt for the round-3 **narrow** re-audit of
SPEC-001 v0.3. Scope is intentionally restricted to verifying that
the 9 round-2 findings closed cleanly without introducing regressions
in the changed sections.

**Why narrow.** Round-2 had 1 CRITICAL but it was a single SQL block,
not a structural issue (the round-2 auditor explicitly recommended
narrow audit in their "Suggested fix order" section). House style:
structural CRITICAL → full re-audit; surgical CRITICAL → narrow audit.

**Cross-model coverage.** If v0.3 was applied by Codex, run this narrow
audit with Claude. If v0.3 was applied by Claude, run with Codex.
Different model than the fix-applier maximizes blind-spot detection.

Expected duration: ~20-30 min (vs ~45-60 min for full audit).

Paste everything between the markers into a fresh session rooted at
`/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are running a NARROW re-audit of SPEC-001 v0.3 to verify that the
9 round-2 audit findings closed cleanly without introducing
regressions. This is NOT a full audit — scope is restricted to the
sections changed in v0.2 → v0.3 plus a regression sanity check on
unchanged sections.

The spec under audit:
  /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md  v0.3

Round-2 audit reference (the findings being closed):
  /Users/augstar/projects/antfleet/specs/SPEC-001-v0-2-audit.md

Round-2 fix prompt (what was supposed to change):
  /Users/augstar/projects/antfleet/specs/FIX_SPEC_001_V0_2_PROMPT.md

Your job: verify each round-2 finding is closed in v0.3, flag any
that aren't, and write a brief report at:
  /Users/augstar/projects/antfleet/specs/SPEC-001-v0-3-audit.md

You are NOT here to find new findings beyond regressions in the
changed sections. Do NOT re-evaluate sections that weren't touched
by the v0.3 patch unless you suspect a cross-section regression.

## Critical constraints

**1. Closure-verification is the primary task.** Each round-2
finding (C2-1 through C2-8 + Q2-1) has a specific fix prescribed in
FIX_SPEC_001_V0_2_PROMPT.md. Verify the fix landed as prescribed.
"Closed" means the spec text now matches the fix; "partial" means
the fix landed incompletely; "open" means the fix didn't land.

**2. Regression check is the secondary task.** Spot-check that the
v0.3 changes did NOT break anything in unchanged sections. The most
likely regression vectors are:
  - Cross-references that pointed at v0.2 line numbers / section
    structure that v0.3 may have shifted.
  - Terms that v0.3 introduced (e.g., FR-A4b, FR-A4c) but unchanged
    sections still reference under the old structure.
  - The change log v0.3 entry should reference every audit finding ID
    addressed (C2-1 through C2-8); missing IDs = MAJOR finding.

**3. No new structural findings.** This is a closure audit, not a
fresh full audit. Do NOT introduce findings about content that
existed unchanged in v0.2 unless you can demonstrate the v0.3 changes
created a NEW inconsistency. If you find structural concerns in
unchanged content, note them as QUESTIONS for a future audit round,
not MAJOR/CRITICAL findings.

**4. Channel-rail regression check is load-bearing.** The round-2
CRITICAL (C2-1) was a channel-rail regression risk. The v0.3 fix
dropped the offending CHECK constraint. Verify:
  - The migration SQL block in § 5.3 no longer contains
    `review_jobs_failure_mode_check`.
  - The FR-A8 commentary correctly explains why (production uses
    additional failure_mode literals like `insufficient_channel_balance`).
  - AC-11's expected outcome list no longer asserts the CHECK
    constraint exists.

## Required reading (in order)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-v0-2-audit.md
   — read the full round-2 audit report (findings + suggested fix
   order + AC coverage matrix). This is your closure checklist.

2. /Users/augstar/projects/antfleet/specs/FIX_SPEC_001_V0_2_PROMPT.md
   — read the full fix prompt. Each prescribed fix has a specific
   expected output (new FR, new SQL, new wording). Use these as
   acceptance criteria for closure verification.

3. /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md (v0.3)
   — read the changed sections:
     - Header (change log v0.3)
     - § 5.3 (migration 0028 SQL block)
     - FR-A4, FR-A4b, FR-A4c (new + rewritten env var contracts)
     - FR-A8 commentary (insufficient_channel_balance note)
     - FR-A9 (parenthetical removal)
     - FR-B3 (new step 2a)
     - § 5.5 (new test infrastructure section)
     - § 7 (renamed heading + rewritten body)
     - AC-4 (new step 5)
     - AC-7 (file enumeration)
     - AC-11 (step 4 update)
     - § 11 (new build steps 1a and 7)
   You MAY skim other sections for regression checks but do NOT
   produce findings about unchanged content.

4. /Users/augstar/projects/antfleet/apps/web/app/api/v1/installations/[id]/review/route.ts
   — confirm `insufficient_channel_balance` is still a real
   production literal (the FR-A8 commentary references this).

5. /Users/augstar/projects/antfleet/apps/web/db/migrations/
   — confirm migration head is still 0027 (so 0028 numbering is
   correct).

6. https://docs.x402.org/core-concepts/http-402 (web-fetch)
   — verify that EIP-3009 `validAfter`/`validBefore` semantics
   described in FR-A4c are correct.

7. https://docs.cdp.coinbase.com/x402/network-support (web-fetch)
   — verify that FR-A4's facilitator URLs are correct (CDP for
   mainnet, x402.org for testnet).

## Closure verification per round-2 finding

For each finding below, verify the v0.3 spec implements the
prescribed fix. Mark CLOSED / PARTIAL / OPEN.

### C2-1 (was CRITICAL)
- Prescribed fix: Drop migration 0028 `failure_mode` CHECK constraint
  entirely; add FR-A8 commentary explaining channel-rail-only literals;
  update AC-11 step 4.
- Verify: § 5.3 SQL has no CHECK on `failure_mode`. FR-A8 has the
  `insufficient_channel_balance` paragraph. AC-11 step 4 mentions
  `failure_mode column remains text with no CHECK constraint`.
- If ANY of the three sub-checks fails → re-flag as CRITICAL.

### C2-2 (was MAJOR)
- Prescribed fix: New FR-A4b defining `ANTFLEET_X402_TREASURY` contract
  (EIP-55 format, settle-pinning, missing-env fail-closed). New
  `x402_pay_to` column in migration 0028.
- Verify: FR-A4b exists and contains the four sub-clauses (Format,
  Ownership/custody, Settle-address pinning, Missing-env behavior,
  Configuration verification). § 5.3 SQL adds `x402_pay_to` column +
  index.
- Partial closure if FR-A4b exists but a sub-clause is missing.

### C2-3 (was MAJOR)
- Prescribed fix: FR-A4 rewritten with `X402_NETWORK`,
  `X402_USDC_ASSET`, `X402_FACILITATOR` env vars. FR-A2 example uses
  `${X402_NETWORK}`, `${X402_USDC_ASSET}`, `${ANTFLEET_X402_TREASURY}`
  placeholders. § 5.1 endpoint contract has new env var rows.
- Verify: FR-A4 has env var table (mainnet + Sepolia columns).
  Sepolia USDC = `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. FR-A2
  example uses placeholders, NOT hardcoded mainnet values. Network/asset
  internal-consistency invariant is stated (startup rejection on
  mismatch).

### C2-4 (was MAJOR)
- Prescribed fix: New FR-A4c with server-side hard ceiling (900s),
  past-time + future-time rejection, per-row authorization persistence.
  FR-B3 gains step 2a (skill sets 600s window). AC-4 gains step 5
  (timing assertion).
- Verify: FR-A4c exists. FR-B3 step 2a exists and mentions
  `validAfter`/`validBefore`. AC-4 step 5 references persisted
  `validBefore` and no `/settle` issued post-terminal.

### C2-5 (was MAJOR)
- Prescribed fix: New § 5.5 enumerating 4 test infrastructure
  deliverables (fixture repo, migration script, seed rows, receipt
  page). § 11 Build steps gains 1a (prereq) and 7 (postreq).
- Verify: § 5.5 contains all four sub-sections (5.5.1 fixture repo,
  5.5.2 migration script, 5.5.3 seed rows, 5.5.4 receipt page) with
  contracts for each. § 11 has 7 steps (was 6).

### C2-6 (was MINOR)
- Prescribed fix: Add sub-bullet under M-7 in v0.2 change log entry:
  "x402 job terminal-state payloads include the review-level URL
  by default, not finding-level."
- Verify: This sub-bullet is in the v0.2 change log entry under M-7.

### C2-7 (was MINOR)
- Prescribed fix: AC-7 "How to verify" line enumerates the channel-rail
  test file gate set explicitly (no more "etc.").
- Verify: AC-7's verification line names specific test file paths.

### C2-8 (was MINOR)
- Prescribed fix: Rename § 7 heading from "Phase findings encoded in
  SPEC-001 v0.1" to "Audit findings encoded in this spec". Rewrite
  body with round-1 + round-2 closure summary.
- Verify: § 7 heading is "Audit findings encoded in this spec" (no
  version marker). Body summarizes both audit rounds.

### Q2-1 (was QUESTION)
- Prescribed fix: Process-gated (no spec change). Acknowledge in v0.3
  change log.
- Verify: v0.3 change log mentions Q2-1 with "no spec change; process
  gate retained."

## Regression checks on unchanged sections

After verifying closures, run these spot-checks for cross-section
regressions introduced by v0.3:

### R-1. Change log v0.3 references every fix
- Action: Read the v0.3 change log entry.
- Pass: Every audit finding ID (C2-1, C2-2, C2-3, C2-4, C2-5, C2-6,
  C2-7, C2-8) and Q2-1 appears at least once.
- Fail: Missing ID = MAJOR finding (incomplete documentation).

### R-2. Cross-references to FR-A4 still resolve
- Action: Grep the spec for references to "FR-A4" and verify each
  resolves correctly (either to the rewritten FR-A4 itself, or to the
  new FR-A4b / FR-A4c).
- Pass: All references resolve to existing FRs.
- Fail: Any broken cross-reference = MAJOR.

### R-3. FR-A9 parenthetical was removed (not just modified)
- Action: Grep for "10 minutes by the skill runner" or
  "set to ~10 minutes".
- Pass: Zero matches (parenthetical fully removed).
- Fail: Match = MINOR (the prescribed fix said replace with cross-
  reference to FR-B3 / FR-A4c).

### R-4. Migration 0028 SQL block compiles as valid SQL
- Action: Mentally parse the SQL in § 5.3.
- Pass: ALTER TABLE statements are syntactically valid; column names
  match those referenced in FRs; CHECK constraint on `payment_rail`
  (which IS prescribed) is present; no CHECK on `failure_mode`.
- Fail: Syntax error or constraint mismatch = MAJOR.

### R-5. No new OOS items pulled in
- Action: Re-read § 2.2 (out-of-scope list).
- Pass: List unchanged from v0.2 (sybil, adversarial, private-via-x402,
  Bankr listing, PR-comment-in-x402 still deferred; true-SHA-only
  still deferred per v0.2 addition).
- Fail: Any deferral contracted = MAJOR (scope creep).

### R-6. Dual-rail isolation invariant text preserved
- Action: Check FR-E1 wording.
- Pass: FR-E1 still says `reviewPR()` is called identically from both
  rails; no rail-aware code in pipeline.
- Fail: Modified = CRITICAL (load-bearing invariant violation).

### R-7. Aeon-gate removability invariant preserved
- Action: Check FR-C3 wording.
- Pass: FR-C3 unchanged.
- Fail: Modified = CRITICAL.

## Severity rubric (this audit)

  CRITICAL — A round-2 finding marked CLOSED above is actually NOT
             closed (re-flag at original severity). OR a v0.3 change
             introduced a new channel-rail regression. OR an invariant
             (FR-C3, FR-E1) was inadvertently modified.

  MAJOR    — A prescribed fix landed only partially. OR a cross-section
             regression (R-1 through R-5 above failing).

  MINOR    — A prescribed MINOR fix is missing or wrongly applied. OR
             cosmetic inconsistency introduced by v0.3 changes.

  QUESTION — Auditor cannot determine from spec text + source code
             whether closure is complete. Carry forward for future
             discussion; do not block on this.

## Output format

Write to:
  /Users/augstar/projects/antfleet/specs/SPEC-001-v0-3-audit.md

Structure:

  # SPEC-001 v0.3 Narrow Re-Audit Report
  Auditor: <model name + version>
  Spec audited: SPEC-001 v0.3 (commit <hash if known, else "uncommitted">)
  Round-2 audit reference: specs/SPEC-001-v0-2-audit.md
  Audit completed: <UTC timestamp>
  Audit scope: NARROW (closure verification for round-2 findings + regression checks)

  ## TL;DR verdict

  READY TO BUILD | NEEDS REVISION

  One paragraph: closure rate (X / 9), regression check pass/fail,
  any new findings.

  ## Round-2 closure matrix

  | Round-2 ID | Round-2 severity | v0.3 status | Notes |
  |---|---|---|---|
  | C2-1 | CRITICAL | CLOSED/PARTIAL/OPEN | ... |
  | C2-2 | MAJOR    | CLOSED/PARTIAL/OPEN | ... |
  | C2-3 | MAJOR    | CLOSED/PARTIAL/OPEN | ... |
  | C2-4 | MAJOR    | CLOSED/PARTIAL/OPEN | ... |
  | C2-5 | MAJOR    | CLOSED/PARTIAL/OPEN | ... |
  | C2-6 | MINOR    | CLOSED/PARTIAL/OPEN | ... |
  | C2-7 | MINOR    | CLOSED/PARTIAL/OPEN | ... |
  | C2-8 | MINOR    | CLOSED/PARTIAL/OPEN | ... |
  | Q2-1 | QUESTION | CLOSED (process-gated) | ... |

  ## Regression check results

  | Check | Pass/Fail | Notes |
  |---|---|---|
  | R-1 change log completeness | ... | ... |
  | R-2 FR-A4 cross-references | ... | ... |
  | R-3 FR-A9 parenthetical removed | ... | ... |
  | R-4 Migration SQL syntax | ... | ... |
  | R-5 OOS list preserved | ... | ... |
  | R-6 Dual-rail isolation preserved | ... | ... |
  | R-7 Aeon-gate removability preserved | ... | ... |

  ## New findings (if any)

  ### CRITICAL (N)
  ### MAJOR (N)
  ### MINOR (N)
  ### QUESTIONS (N)

  Format per finding: title, severity, spec ref, what's wrong, fix
  direction.

  ## Build-readiness recommendation

  If all 9 round-2 findings CLOSED and all 7 regression checks PASS
  with no new findings: READY TO BUILD. Recommend the operator
  proceed to BUILD_SPEC_001_IMPL_PROMPT.md.

  If any partial closure or new finding: NEEDS REVISION. List the
  narrow patch required for v0.4 (should be ≤30 lines of edits).

## What NOT to do

  - Do NOT re-audit unchanged sections beyond the regression checks
    (R-1 through R-7). This is a narrow audit.
  - Do NOT introduce new findings about pre-existing content unless
    v0.3 changes created a NEW inconsistency.
  - Do NOT modify the spec.
  - Do NOT run ACs (implementation doesn't exist).

When done, print a 150-word summary to stdout:
  - Verdict (READY TO BUILD / NEEDS REVISION)
  - Closure rate (X / 9 round-2 findings)
  - Regression check pass count (X / 7)
  - Any new findings (count by severity)
  - One-line build-readiness recommendation

Then stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist (quick — ~3 min):

1. **Closure rate** — 9/9 expected. Anything less = at least one fix
   missed.
2. **Regression checks** — 7/7 PASS expected. Any FAIL = blocker.
3. **New findings** — 0 expected for a clean v0.3. 1-2 MINORs
   acceptable if cosmetic.

If READY TO BUILD with 9/9 + 7/7 + 0 new findings:
- Commit v0.3 (if not already committed) + the v0.3 audit report
- Write `BUILD_SPEC_001_IMPL_PROMPT.md` for the ~1-week implementation
- Implementation begins

If NEEDS REVISION:
- Write `FIX_SPEC_001_V0_3_PROMPT.md` (expected: trivial, ~30 lines)
- Apply, narrow re-audit again
- Should converge in ≤1 more round

Expected total path from here: this narrow audit → BUILD prompt.
Target spec-lock: 2026-05-30 EOD. ~1-week build → ship by 2026-06-06.
