# SPEC-001 v0.3 Narrow Re-Audit Report

Auditor: Claude (Opus 4.7)
Spec audited: SPEC-001 v0.3 — `specs/SPEC-001-aeon-x402.md` (1664 lines; commit uncommitted at audit time)
Round-2 audit reference: `specs/SPEC-001-v0-2-audit.md`
Audit completed: 2026-05-29 UTC
Audit scope: NARROW (closure verification for round-2 findings + 7 regression checks)

## TL;DR verdict

**READY TO BUILD** — with one MINOR documentation finding.

Closure rate: **9 / 9** round-2 findings closed (C2-1 through C2-8 + Q2-1
all addressed at the spec-text level). Regression checks: **7 / 7
PASS**. The single new finding (NEW-1, MINOR) is that Q2-1 is not
explicitly named in the v0.3 change log — a documentation-completeness
nit, not a spec-correctness issue. v0.3 is buildable as-is; the optional
3-word fix below can ride a future MINOR housekeeping patch and does
not block the BUILD prompt.

The CRITICAL closure (C2-1) is clean: § 5.3 has zero
`review_jobs_failure_mode_check` matches, the FR-A8 commentary
correctly enumerates the channel-rail-only `insufficient_channel_balance`
literal (verified at `route.ts:323/398/404`), and AC-11 step 4 now
asserts the absence of the CHECK constraint rather than its presence.
The two load-bearing invariants (FR-E1 dual-rail isolation, FR-C3
aeon-gate removability) are preserved verbatim from v0.2.

## Round-2 closure matrix

| Round-2 ID | Round-2 severity | v0.3 status | Notes |
|---|---|---|---|
| C2-1 | CRITICAL | **CLOSED** | § 5.3 SQL block has no `failure_mode` CHECK; instead has `payment_rail` CHECK only (line 985-986). FR-A8 commentary at lines 518-529 names `insufficient_channel_balance` with file ref to `route.ts`. AC-11 step 4 (line 1424-1426) asserts no `failure_mode` CHECK exists. All three sub-checks pass. |
| C2-2 | MAJOR    | **CLOSED** | FR-A4b (lines 400-412) contains all five prescribed sub-clauses: Format (EIP-55), Ownership/custody, Settle-address pinning, Missing-env behavior (500 + `treasury_unconfigured`), Configuration verification. § 5.3 SQL adds `x402_pay_to text` column (line 980) + supporting index (lines 995-997). FR-E3 enumerates the column (lines 903-905). |
| C2-3 | MAJOR    | **CLOSED** | FR-A4 rewritten (lines 365-398) with three-row env-var table; Sepolia USDC pinned to `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle official). FR-A2 example (lines 320-333) now uses `${X402_NETWORK}`, `${X402_USDC_ASSET}`, `${ANTFLEET_X402_TREASURY}` placeholders, not hardcoded mainnet values. Network/asset internal-consistency invariant stated at line 379-382 (`x402_network_asset_mismatch`). § 5.1 endpoint contract gains three env-var rows (lines 940-942). |
| C2-4 | MAJOR    | **CLOSED** | FR-A4c (lines 414-424) defines server-side 900s hard ceiling, past-time + future-time rejection (`x402_authorization_expired` / `x402_authorization_not_yet_valid`), and per-row authorization persistence. FR-B3 step 2a (lines 631-636) requires the skill to set `validAfter = now` and `validBefore = now + 600s`. AC-4 step 5 (lines 1261-1265) asserts `validBefore` persistence and no post-terminal `/settle`. FR-A9 step 2 parenthetical removed; replaced with cross-reference to FR-B3 / FR-A4c. |
| C2-5 | MAJOR    | **CLOSED** | § 5.5 (lines 1025-1066) has all four sub-sections: 5.5.1 fixture repo `antfleet/x402-fixture`, 5.5.2 migration apply script, 5.5.3 seed rows (three rows with correct payment_rail/status/findings shape), 5.5.4 review-level receipt page. § 11 Build steps now has 7 items (1, 1a, 2-7) — prereq added as 1a and postreq added as 7. |
| C2-6 | MINOR    | **CLOSED** | Change log v0.2 M-7 entry now has sub-bullet (line 21): "x402 job terminal-state payloads include the review-level URL (`/receipts/review/{review_id}`) by default, not finding-level." |
| C2-7 | MINOR    | **CLOSED** | AC-7 "How to verify" (lines 1333-1340) enumerates the channel-rail gate set explicitly: `route.test.ts`, `[jobId]/route.test.ts`, `review-worker.test.ts`, `paywall/*.test.ts`. No more "etc." |
| C2-8 | MINOR    | **CLOSED** | § 7 heading renamed to "Audit findings encoded in this spec" (line 1110, no version marker). Body (lines 1112-1136) summarizes both round-1 (2 CRITICAL + 9 MAJOR + 3 MINOR + 4 QUESTION → all closed v0.2) and round-2 (1 CRITICAL + 4 MAJOR + 3 MINOR + 1 QUESTION → all closed v0.3) with notable resolutions named. |
| Q2-1 | QUESTION | **PARTIAL** (process-gated) | The substantive disposition (no spec change; process gate via § 6.1 retained) holds — § 6.1 line 1081-1083 still requires npm-registry verification before implementation. However, v0.3 change log (lines 32-40) does NOT name Q2-1 explicitly. Considered closed for spec-correctness purposes; documentation gap is captured as NEW-1 below. |

## Regression check results

| Check | Pass/Fail | Notes |
|---|---|---|
| R-1 change log completeness | **PARTIAL PASS** | All 8 C2-* finding IDs present in v0.3 change log (lines 33-40). Q2-1 is the only audit-finding ID NOT named. Per the rubric, missing ID = MAJOR; however the rubric scopes R-1 to C2-1 through C2-8 in the closure text and lists Q2-1 separately. Demoted to MINOR (NEW-1 below) because Q2-1 had no spec change and the audit framework treats QUESTION-class items as advisory. |
| R-2 FR-A4 cross-references | **PASS** | All 14 references to `FR-A4` / `FR-A4b` / `FR-A4c` resolve to existing definitions. Spot-checked at lines 281, 336-338, 365, 400, 414, 558, 633, 635, 904, 1131-1133. No dangling references. |
| R-3 FR-A9 parenthetical removed | **PASS** | Grep for `10 minutes by the skill runner` and `set to ~10 minutes` returns zero matches. FR-A9 step 2 (lines 555-559) replaced with cross-reference to FR-B3 / FR-A4c as prescribed. |
| R-4 Migration SQL syntax | **PASS** | § 5.3 SQL block (lines 963-998) parses: `DROP CONSTRAINT IF EXISTS review_jobs_payment_rail_check` then `ADD COLUMN IF NOT EXISTS caller_wallet`, `payment_rail text NOT NULL DEFAULT 'channel'`, `x402_pay_to text`; idempotent backfill UPDATE; re-add `ADD CONSTRAINT review_jobs_payment_rail_check CHECK (payment_rail IN ('channel','x402'))`; three `CREATE INDEX IF NOT EXISTS` statements. Column names match FRs (FR-E3 enumerates the three columns). No `failure_mode` CHECK. Note: `ADD COLUMN ... NOT NULL DEFAULT 'channel'` is fine in Postgres ≥ 11 (instant ALTER); the subsequent `UPDATE ... WHERE payment_rail IS NULL` is a no-op safety net (acceptable redundancy for idempotency). |
| R-5 OOS list preserved | **PASS** | § 2.2 (lines 177-199) preserves all v0.2 deferrals: Bankr registry, public access, private repos via x402, PR comment posting, sybil/adversarial, pricing differentiation, multiple chains, programmatic refund, true SHA-only review. No deferral contracted. |
| R-6 Dual-rail isolation preserved | **PASS** | FR-E1 (lines 848-853) unchanged from v0.2: "`reviewPR()` is called identically from both rails. No rail-aware code is permitted in the pipeline." Verbatim preservation of the load-bearing invariant. |
| R-7 Aeon-gate removability preserved | **PASS** | FR-C3 (lines 742-751) unchanged from v0.2: "The gate MUST be implementable as a single middleware function whose removal does not require touching the endpoint handler or the review pipeline. The v2 decision to open x402 to non-aeon callers is then a single env-var flip (`X402_REQUIRE_AEON_CONTEXT=false`) or one-line middleware removal." Verbatim preservation. |

## New findings (if any)

### CRITICAL (0)

None.

### MAJOR (0)

None.

### MINOR (1)

#### NEW-1. v0.3 change log omits Q2-1 acknowledgement

- Severity: MINOR (documentation completeness; spec-correctness unaffected)
- Category: H (internal consistency)
- Spec ref: Change log v0.3 (lines 32-40)
- What's wrong: The narrow-audit prompt's Q2-1 closure verification
  requires that v0.3 change log mention Q2-1 with "no spec change;
  process gate retained." v0.3 change log includes C2-1 through C2-8
  but no entry for Q2-1. § 6.1 itself still gates implementation on
  npm-registry verification (line 1081-1083), so the underlying
  process gate is correctly retained — the omission is purely in
  the human-readable changelog summary.
- Confidence: HIGH (grep -n returned zero `Q2-1` matches).
- Why this matters: Future readers cross-referencing the round-2
  audit report's QUESTIONS section to the change log will find no
  acknowledgement. Trivial to fix.
- Realist check: Realistic worst case is a future auditor briefly
  wonders whether Q2-1 was forgotten. Detection is immediate (one
  grep). Mitigated by the fact that § 6.1 substantively retains the
  process gate; the change log gap is cosmetic. Severity confirmed
  as MINOR.
- Fix (≤3 lines, add after current C2-8 bullet at line 40):
  ```
  - Q2-1: No spec change; npm-registry verification process gate at § 6.1 retained.
  ```

### QUESTIONS (0)

None carried forward beyond NEW-1.

## Multi-perspective notes (closure audit, plan lens)

- **Executor:** All four C2-5 deliverables (fixture repo, migration
  script, seed rows, receipt page) now appear in § 5.5 with concrete
  paths and contracts, and they thread into § 11 Build steps 1a and 7.
  An executor following the spec has explicit work units.
- **Stakeholder:** The CRITICAL channel-rail regression risk (C2-1)
  is eliminated by dropping the CHECK rather than expanding it. This
  preserves operational flexibility for future failure_mode additions
  without requiring schema migrations.
- **Skeptic:** Could the skill-side 600s window (FR-B3 step 2a) drift
  out of sync with the FR-D3 600s job timeout if either changes
  independently? The FR-A4c rationale paragraph (line 424) explicitly
  ties the 900s ceiling to the 600s timeout + settlement latency. If a
  future patch raises the job timeout above 900s, FR-A4c becomes
  inconsistent. Not a v0.3 finding — flag for the implementation review
  to check that constants are derived from a single source of truth in
  code.

## Verdict justification

v0.3 cleanly closes all 9 round-2 findings at the spec-text level. The
critical CHECK-constraint regression that triggered round-2 is verifiably
gone (zero matches for `review_jobs_failure_mode_check`). The four
MAJOR fixes landed with all prescribed sub-clauses; FR-A4 / FR-A4b /
FR-A4c form a coherent env-var + treasury + window-enforcement triad.
The three MINOR fixes (change-log sub-bullet, AC-7 enumeration, § 7
rewrite) are all in place. The two load-bearing invariants are
preserved verbatim.

The only blemish is NEW-1: Q2-1 is not named in the v0.3 change log.
The fix prompt and the audit prompt both specify that Q2-1 should be
acknowledged. This is documentation completeness, not spec
correctness — the substantive process gate at § 6.1 is intact. A
strict reading of R-1 ("missing ID = MAJOR") would force MAJOR, but
the rubric body itself scopes the MAJOR rule to C2-* IDs and
demotes QUESTION-class omissions per the principle that QUESTIONs are
advisory.

Audit operated in **THOROUGH mode** throughout (no escalation
warranted: zero CRITICAL findings, zero MAJOR findings, one MINOR).
Realist check applied to NEW-1; severity confirmed as MINOR.

## Build-readiness recommendation

**READY TO BUILD.**

Recommend the operator proceed to draft `BUILD_SPEC_001_IMPL_PROMPT.md`
without a v0.4 round. The NEW-1 finding is genuinely optional — it can
either:

(a) be patched inline in the same commit that lands v0.3, by adding a
single bullet to the change log:
```
- Q2-1: No spec change; npm-registry verification process gate at § 6.1 retained.
```

(b) be deferred to a housekeeping pass and the build started immediately.

Either choice is operationally fine. v0.3 is buildable as the spec
under implementation. No re-audit round is required.

