# SPEC-001 v0.5 Implementation Fix Audit Report

- **Auditor:** Multi-agent workflow (Claude Opus subagents per lane + synthesizer)
- **Fix audited:** FIX_SPEC_001_IMPL_V1_PROMPT.md applied; SPEC bumped v0.4 → v0.5
- **Base commit:** e4475b8 + uncommitted working tree (26 files modified + 2 new test files)
- **External PRs:** antfleet/aeon-skills PR #1, aaronjmars/aeon PR #270
- **Audit completed:** 2026-05-29

---

## TL;DR verdict

**READY TO SHIP** (with two minor follow-ups recommended pre-mainnet)

Closure rate: **28 of 31 prior findings fully closed (90%)**, 3 partial closures (P1.2 cross-wallet test semantic, P1.5 migration fixture realism, Part B FR-B3 client-side window). All three load-bearing invariants hold: FR-E1 dual-rail isolation preserved (review-pipeline.ts zero-diff vs e4475b8), FR-C3 aeon-gate removability preserved (X402_REQUIRE_AEON_CONTEXT=false short-circuit intact), AC-7 channel-rail no regression (only prescribed cost_cap_exceeded removal from refund.ts). Both external PRs are open and mergeable. New findings: **0 CRITICAL, 2 MAJOR, 7 MINOR, 3 QUESTIONS** — none blocking. Top residual risks: (1) the P1.2 cooldown test does not actually exercise W2≠W1 even though that is the entire point of AC-6 and the bug it was written to catch; (2) the migration 0028 fixture is structurally vacuous (fakeSql returns canned state regardless of executed SQL) so SQL syntax/typo regressions would slip through; (3) the Part B runner's `authorizationWindowSeconds: 600` is a no-op against @x402/evm@2.13.0 — the 600s window holds only because the server's `maxTimeoutSeconds` happens to also be 600. All three are tracked, none are launch-blockers.

---

## Lane verdicts

| Lane | Verdict | Notes |
|---|---|---|
| Lane 1: P0 closure matrix | PASS | All 6 P0 fixes land cleanly with prescribed tests |
| Lane 2: P1 closures + invariant regression | PARTIAL | P1.2 cross-wallet semantic + P1.5 ephemeral PG missing; invariants preserved |
| Lane 3: P2/P3 closures + spec v0.5 alignment | PASS | 14 P2 closures + 2 P3 PRs open/mergeable + spec v0.5 byte-aligned |
| Lane 4: New AC test integrity | PARTIAL | 6/8 robust; 0028.test.ts vacuous fakeSql; env.test.ts misses P2.1 probe |
| Lane 5: Part B run.mjs first-audit | PARTIAL | FR-B3 client-side 600s window is a no-op; functionally safe via server contract |

---

## Closure matrix (prior 31 findings)

### CRITICAL (1)

| ID | Original | Status | Evidence | Notes |
|---|---|---|---|---|
| P3.1 / P3.2 (Part B unshipped) | CRITICAL | closed | antfleet/aeon-skills PR #1 OPEN+MERGEABLE (SKILL.md, run.mjs, package.json, skills-pack.json); aaronjmars/aeon PR #270 OPEN with skill-packs.json/README/docs delta | Both PRs ready for merge; PR #1 missing optional `.outputs/` template (non-blocking, spec only requires 3 files) |

### MAJOR (11)

| ID | Original | Status | Evidence | Notes |
|---|---|---|---|---|
| P0.1 wall-clock timeout | MAJOR | closed | `review-job-worker.ts:319` calls `withX402WallClockTimeout`; helper at :506-522 uses Promise.race + WallClockTimeoutError; test at `review-job-worker.x402.test.ts:270-303` asserts failureMode='timeout', settlePayment NOT called | Timer cleared in finally; classifyError honors failureModeTag |
| P0.2 pre-verify ordering | MAJOR | closed | `route.ts:127-244` ordering: aeon-gate → config → sig presence → cooldown → extractClaimedSigner → wallet rate-limit → idempotency → verifyPayment → createJob; tests at `route.test.ts:172-232` | sigil-missing path returns 402 without consuming rate-limit |
| P0.3 PAYMENT-RESPONSE header | MAJOR | closed | `[jobId]/route.ts:62-68` attaches only when settled; tests at `[jobId]/route.test.ts:52-107` assert presence on settled, null on non-settled/expired | Minor: GET route only sets Expose-Headers on settled responses (consistent with no leak risk) |
| P0.4 FR-A2 spec rewrite | MAJOR | closed | `SPEC-001:323-365` payload mirrors `facilitator.ts:49-72` exactly; source-of-truth note at :360-365 | v0.5 change log bullet 1 covers this |
| P0.5 rail-agnostic receipt | MAJOR | closed | `queries.ts:1155-1164` LEFT JOIN without payment_rail predicate; `page.tsx:29` reads paymentRail; new `page.test.tsx:111-127` asserts channel-rail divergence | ORDER BY created_at DESC NULLS LAST (P2.12 tie-breaker) |
| P0.6 aeon-gate disclosure | MAJOR | closed | `llms.txt:25-27`, `page.tsx:416-418`, `antfleet.json/route.ts:43-50` all carry disclosure; manifest test pins access_scope literal | All three surfaces consistent |
| P1.1 receipt page test | MAJOR | closed | New `page.test.tsx` covers complete+findings, complete+0findings (em-dash), failed+provider_error, channel-rail | renderToString of actual component |
| P1.2 cooldown cross-wallet | MAJOR | **partial** | `route.test.ts:172-189` asserts cooldown short-circuit; BUT job() and paymentSignature() default to SAME wallet 0x...0001 | The cross-wallet semantic (load-bearing per spec line 1400) is not exercised — test would pass identically if cooldown were wallet-scoped |
| P1.3 cost-cap settlement | MAJOR | closed | `review-job-worker.x402.test.ts:227-268` asserts failureMode='cost_cap_exceeded', settlePayment NOT called, markX402SettlementNotSettled called | Threshold 1.51 > 1.5 cap |
| P1.4 idempotency-before-verify | MAJOR | closed | `route.test.ts:215-232` asserts 200, verifyPayment+createJob+scheduleWorker NOT called when findJobByIdempotencyKey hits | All four assertions present |
| P1.5 migration apply test | MAJOR | **partial** | `0028.test.ts` imports real apply/verify functions but backs with synchronous `fakeSql()` stub; statement-array assertions present | No ephemeral Postgres; SQL syntax errors / type mismatches / real catalog state not exercised |
| P1.6 facilitator URL spec | MAJOR | closed | `env.ts:7-8` constants match `SPEC-001:8,401` byte-for-byte; network-pinning at :68-75 | |
| P1.7 receipt copy | MAJOR | closed | `page.tsx:70` em-dash literal, `:162-163` 'Payment not settled' literal; both asserted | Both copy fixes confirmed |
| SPEC v0.5 version | MAJOR | closed | `SPEC-001:3` 'Version: 0.5 (2026-05-29, implementation audit closing)' | |
| SPEC v0.5 changelog | MAJOR | closed | `SPEC-001:6-14` 8-bullet block enumerates all major edits | |
| SPEC v0.5 FR-A2 alignment | MAJOR | closed | `SPEC-001:329-355` example mirrors `facilitator.ts:49-72`; line 360-365 declares code authoritative | |
| SPEC v0.5 FR-E3 alignment | MAJOR | closed | `SPEC-001:945-968` enumerates all 9 x402 columns; SQL block at :1035-1083 mirrors migration verbatim | |
| SPEC v0.5 FR-C3 alignment | MAJOR | closed | `SPEC-001:780-786` clarifies inline-function vs middleware; aligns with `route.ts:130` | |
| SPEC v0.5 FR-A4 URLs | MAJOR | closed | `SPEC-001:4,401` match `env.ts:7-8` exactly | |

### MINOR (14)

| ID | Original | Status | Evidence | Notes |
|---|---|---|---|---|
| P2.1 boot probe | MINOR | closed | `env.ts:154-175` maybeProbeFacilitator() fire-and-forget with 5s AbortController, NODE_ENV=test short-circuit, probedFacilitators dedup, warn-only | Matches FR-A4 invariant 3; not exercised by env.test.ts (see Lane 4 partial) |
| P2.2 expired transition | MINOR | closed | `[jobId]/route.ts:42-45,78-85` isExpiredInFlight + lazy markX402JobExpired | Option (b) chosen |
| P2.3 cooldown excludes failed | MINOR | closed | `rate-limit.ts:58` WHERE status IN ('queued','running','complete') — 'failed' excluded | Allows fresh retry post-fail |
| P2.4 aeon-gate budget preservation | MINOR | closed | `route.test.ts:234-256` asserts 403 + checkWalletRateLimit NOT called + subsequent valid call retains quota | |
| P2.5 Retry-After header | MINOR | closed | `route.test.ts:191-213` asserts 429, Retry-After='123', body envelope shape | |
| P2.6 CI Sepolia smoke | MINOR | closed | `.github/workflows/ci.yml:26` invokes `x402-live-smoke.ts --mode verify --skip-on-missing-creds`; flag at script:228 | No-op without secrets, real smoke with secrets |
| P2.7 refund FR-E1 isolation | MINOR | closed | `paywall/refund.ts:18` REFUNDABLE = {provider_error, timeout, internal} — cost_cap_exceeded removed; x402-only set lives in `x402/review-job-result.ts:13-19` | Channel module no longer references x402 concept |
| P2.8 FR-E3 column count | MINOR | closed | Spec lists 9 columns matching migration 0028 | Fix prompt said 6, code/spec correctly say 9 |
| P2.9 manifest access_scope | MINOR | closed | `route.test.ts:34-42` asserts both endpoints carry access_scope literal | |
| P2.10 tightened signer extraction | MINOR | closed | `facilitator.ts:272-278` reads only authorization.from; `facilitator.test.ts:83-91` asserts override 'signer' field ignored | Signer attack vector defended |
| P2.11 FR-C3 inline-function paragraph | MINOR | closed | `SPEC-001:780-786` added | |
| P2.12 newest-job tie-breaker | MINOR | closed | `queries.ts:1168` ORDER BY j.created_at DESC NULLS LAST LIMIT 1 | |
| P2.13 skills-pack.json bump | MINOR | closed | `SPEC-001:1110-1115` documents bump; PR #1 includes skills-pack.json (+9/-2) v2.0→v2.1 | |
| P2.14 v0.5 changelog | MINOR | closed | `SPEC-001:6-14` 8-bullet block | |

### QUESTIONS (5)

The original audit's 5 QUESTION-class items were addressed inline by the fix prompt (P2.10 tightened extraction closed Q-1; P2.11 inline-function paragraph closed Q-2; Q-3/4/5 were dispositioned as accept-as-is per the change log). No outstanding QUESTION-class items from the prior audit remain open.

---

## Load-bearing invariant verdict

- **FR-E1 dual-rail isolation: PRESERVED** — `review-pipeline.ts` has zero diff vs e4475b8; only channel-rail diff is the prescribed `cost_cap_exceeded` removal from `refund.ts` (AC-7).
- **FR-C3 aeon-gate removability: PRESERVED** — `aeon-gate.ts:22` X402_REQUIRE_AEON_CONTEXT=false short-circuit remains intact; gate is a top-of-handler function call removable via env flag.
- **AC-7 channel-rail no regression: PRESERVED** — channel-rail paywall flow unchanged; channel receipt page branch renders 'Rail: channel' with no x402 settlement leakage (asserted by new `page.test.tsx:111-127`).

---

## New findings introduced by fix pass

### CRITICAL (0)

None.

### MAJOR (2)

1. **P1.2 cross-wallet cooldown test does not assert cross-wallet semantic.** `route.test.ts:172-189` uses default job() (wallet 0x...0001) and default paymentSignature() (wallet 0x...0001). SPEC AC-6 at `SPEC-001:1390` ('Wallet W2 (different from W1) submits...') is the entire point. As written, the test would pass even if cooldown were wallet-scoped — exactly the regression AC-6 exists to catch. **Fix:** add an explicit case where `findRecentRepoShaJob` returns `job({callerWallet:'0xWALLET_ONE'})` but inbound payment-signature uses `0xWALLET_TWO`.

2. **Migration 0028 test fixture is structurally vacuous.** `0028.test.ts:12-49` fakeSql() ignores SQL it receives and returns hard-coded arrays. verifyMigration0028 reads canned responses; the test asserts equality against the same expected lists. A genuine bug in applyMigration0028 (wrong column name, missing index, mid-statement syntax error) would not surface. **Fix:** spin up pglite/pg-mem/Docker Postgres for this single migration test, OR have fakeSql assert each statement string actually mentions expected column/index names so it cannot pass with a no-op migration.

### MINOR (7)

1. **Poll route's Access-Control-Expose-Headers is set only on settled responses** (`[jobId]/route.ts:62-68`). Acceptable since no leak risk; inconsistent with POST route. Optionally always set on every poll response + OPTIONS preflight.

2. **extractClaimedSigner may not handle x402 v2 outer envelope** (`facilitator.ts:182-191`). Real @x402/evm clients may emit `payload.authorization.from` (nested) vs current top-level `authorization.from`. Existing test uses top-level shape. Verify against real client output in live smoke before mainnet.

3. **P1.5 migration test lacks ephemeral Postgres fixture** (Codex-flagged caveat). Acceptable v1 closure but track for v2.

4. **Wallet rate-limit counts user_input/validation as quota** (`rate-limit.ts:28-31`). Matches FR-D1 since those settle; flagged only for auditor clarity vs cooldown handling.

5. **env.test.ts addition does not exercise the facilitator boot probe** — only tests timeout-env validation. Probe is bypassed when NODE_ENV='test'. Add a test seam or document manual verification path.

6. **Channel-rail page test relies on broad 'channel' substring** (`page.test.tsx:123`). The substring appears in multiple unrelated places; mitigated by companion 'Rail' label check. Tighten to assert specific dd selector.

7. **Part B output template includes `Cached:` line not specified by FR-B4.** Useful and consistent with channel-rail skill; spec/code drift to reconcile (add Cached to FR-B4, likely intended).

8. **Part B `authorizationWindowSeconds: 600` option is a no-op** (`run.mjs:74`). @x402/evm@2.13.0 EvmSchemeConfig accepts only `{rpcUrl}`. Window is server-driven via `paymentRequirements.maxTimeoutSeconds=600`. Functionally safe today; if server ever raises maxTimeoutSeconds, skill will mint longer windows silently. **Fix:** drop dead line + update FR-B3 wording, OR post-process to clamp validBefore client-side. (Severity-debate: between MINOR and MAJOR — listed here because functional behavior is currently correct via server contract.)

9. **validAfter is `now - 600`, not `now`** — spec FR-B3 step 2a is wrong about client behavior. @x402/evm exact client sets validAfter=now-600 for clock-skew tolerance. Update FR-B3 wording.

10. **POST 429 from server exits 2 (permanent), should arguably be exit 3 (transient).** `run.mjs:201-205` maps status<500 to exit 2; AntFleet's own 429 contract is transient. Fix: special-case 429 to exit 3.

### QUESTIONS (3)

1. **PR #1 missing `.outputs/pr-review-antfleet-x402.md` template.** Spot-check parallel `pr-review-antfleet/` folder for a template; if present, add equivalent stub for parity. Non-blocking — spec FR-B1 only requires 3 files.

2. **Runner does not send X-Aeon-Context on the GET poll.** Server's GET route does not call requireAeonContext (status read is non-sensitive, jobIds are uuids). Confirm intent: either lock down GET behind aeon-context, or document as intentionally unauthenticated.

3. **Runner accepts SHA-only invocations.** Server requires sha = head of exactly one open PR. Consider adding SKILL.md warning for users.

---

## Test integrity assessment

Lane 4's grading shows **6 of 8** new/extended test files are genuinely robust closures of their stated AC:

**Robust (closures defended end-to-end with exact-equality, ordering-sensitive assertions cross-checking production literals):**
- `route.test.ts` (P0.2 ordering, AC-3 idempotency, AC-6 cooldown short-circuit, P2.5 retry-after envelope)
- `[jobId]/route.test.ts` (P0.3 PAYMENT-RESPONSE base64 settlement equality, expired lazy-transition)
- `page.test.tsx` (em-dash + 'Payment not settled' literals, channel-rail divergence — em-dash verified U+2014 in both source and test)
- `review-job-worker.x402.test.ts` (P1.3 cost-cap with exact mock-not-called assertions, P0.1 timeout with fake-timer harness)
- `facilitator.test.ts` (P2.10 pre-verify + post-verify signer extraction with attack-vector cases)
- `antfleet.json/route.test.ts` (P0.6 access_scope toMatchObject literal pin)

**Partial / weak:**
- `0028.test.ts` — **vacuous fakeSql** that returns canned 'expected' state regardless of executed SQL. Catches sql-text grep regressions + statement-splitting + function importability; does NOT catch real Postgres semantic errors or constraint name mismatches.
- `env.test.ts` — adds only a timeout-validation case; does not exercise the boot-probe behavior P2.1 named. Probe is unreachable in NODE_ENV='test'.

No outright vacuous green passes among the closures graded `closed`. Mock fidelity is good throughout: typed deps via `X402RouteDeps` would fail typecheck on shape drift; `vi.hoisted` + `vi.mock` pattern correct.

---

## Part B PR assessment

**Both PRs are ready to merge.** PR #1 (antfleet/aeon-skills) ships the four required files; PR #270 (aaronjmars/aeon) updates skill-packs.json + README + docs/community-skill-packs.md.

**Key call-outs:**

- **EIP-3009 600s window enforcement: weak link.** Runner passes `authorizationWindowSeconds: 600` to registerExactEvmScheme, but @x402/evm@2.13.0 EvmSchemeConfig is `{rpcUrl?: string}` only — the option is silently ignored. Window is set by `validAfter = now - 600` (client, hard-coded) and `validBefore = now + paymentRequirements.maxTimeoutSeconds` (server-driven). The 600s ceiling holds because the server happens to set `X402_MAX_TIMEOUT_SECONDS=600`. Spec FR-B3 wording is wrong about both directions of the window. Functionally safe today; track for spec reconciliation.

- **Private key handling: safe.** `AEON_X402_WALLET_PRIVATE_KEY` validated as `/^0x[0-9a-fA-F]{64}$/`, never logged. `requireEnv()` error prints var NAME only. Key passed to `privateKeyToAccount()` inside `makeClient()` and never echoed.

- **Polling/retry logic: correct.** No hand-rolled 402→sign→retry loop; httpClient.fetch (x402HTTPClient wrapper) handles the single retry internally. POLL_INTERVAL=10s, POLL_TIMEOUT=10min. GET-only polling; no double-payment vector.

- **Output format: spec-compliant with one drift.** Includes 'Paid via: x402', 'Receipt:' URL, no 'PR comment:' line (matches FR-B4). Adds undocumented 'Cached:' line — useful, matches channel-rail skill behavior, but spec/code drift to reconcile.

- **Exit codes: clean.** 0=success, 2=permanent (bad env/argv/4xx submit/terminal failed/expired), 3=transient (5xx, poll_timeout, network). Note: 429 currently maps to 2 — should arguably be 3.

- **Aeon-context header: wired correctly** on POST; absent on GET (acceptable, GET is unauthenticated by design — confirm intent).

---

## Pre-launch operator gates

After this fix lands, what remains before mainnet:

- **OQ-1: HMAC secret distribution (Aaron)** — coordinate so aeon-skills installs receive AEON_X402_WALLET_PRIVATE_KEY and AEON_CONTEXT_TOKEN safely.
- **OQ-5: CDP API keys (operator)** — provision Coinbase CDP credentials for mainnet facilitator URL.
- **AC-1a Sepolia smoke** — automated by P2.6 CI wiring; runs each push, skips without creds, executes when secrets present.
- **AC-1 mainnet smoke** — manual, post-OQ resolution; validate end-to-end against CDP mainnet facilitator before any external announcement.
- **Aaron merges aaronjmars/aeon PR #270** — registry update so `aeon` CLI picks up new skill entry.
- **antfleet-ops merges antfleet/aeon-skills PR #1** — or wait for outside review per project preference.
- **Optional pre-mainnet patches:**
  - Add cross-wallet P1.2 test case (15 min)
  - Reconcile FR-B3 wording vs @x402/evm actual behavior (spec edit, 20 lines)
  - Verify extractClaimedSigner against real @x402/evm output during Sepolia smoke

---

## Ship recommendation

**READY TO SHIP** with the following plan:

**Operator commits the local fix changes** — suggested logical commit groupings:

1. **P0 + invariant guardrails:** `apps/web/lib/review-job-worker.ts`, `apps/web/lib/review-job-worker.x402.test.ts`, `apps/web/app/api/v1/review/x402/route.ts`, `apps/web/app/api/v1/review/x402/route.test.ts`, `apps/web/app/api/v1/review/x402/[jobId]/route.ts`, `apps/web/app/api/v1/review/x402/[jobId]/route.test.ts` (new), `apps/web/lib/x402/facilitator.ts`, `apps/web/lib/x402/facilitator.test.ts`, `apps/web/lib/x402/env.ts`, `apps/web/lib/x402/env.test.ts`, `apps/web/lib/x402/rate-limit.ts`, `apps/web/lib/x402/review-job-result.ts`, `apps/web/lib/paywall/refund.ts`, `apps/web/lib/review-job-queries.ts`, `apps/web/db/queries.ts`.

2. **Receipt page + manifest disclosure (P0.5/P0.6):** `apps/web/app/receipts/review/[id]/page.tsx`, `apps/web/app/receipts/review/[id]/page.test.tsx` (new), `apps/web/app/.well-known/antfleet.json/route.ts`, `apps/web/app/.well-known/antfleet.json/route.test.ts`, `apps/web/app/page.tsx`, `apps/web/public/llms.txt`.

3. **Migration + CI smoke:** `apps/web/db/migrations/0028.test.ts`, `apps/web/db/migrations/apply-migration-0028.ts`, `apps/web/scripts/x402-live-smoke.ts`, `.github/workflows/ci.yml`.

4. **Spec v0.5 + audit docs:** `specs/SPEC-001-aeon-x402.md`, `apps/web/lib/x402/implementation-notes.md`, `specs/FIX_SPEC_001_IMPL_V1_PROMPT.md` (new), `specs/SPEC-001-impl-audit.md` (new), `specs/SPEC-001-impl-v1-audit.md` (new — this file).

**Both external PRs proceed through their merge paths.** Sepolia smoke validates end-to-end via CI on push. Mainnet smoke after OQ-1 + OQ-5 resolve.

**Two optional pre-mainnet patches** (~50 lines combined) to tighten the two MAJOR new findings:
- Add cross-wallet P1.2 test case to `route.test.ts` (~15 lines, +10 min)
- Either add pglite to `0028.test.ts` (~40 lines) or extend fakeSql to assert SQL contents (~20 lines, +30 min)
- Reconcile FR-B3 wording to match @x402/evm actual behavior (~15 spec lines)

Neither is launch-blocking; both are tracked as v0.6 follow-ups.
