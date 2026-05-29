# SPEC-001 v0.4 Implementation Audit Report

Auditor: Multi-agent workflow (Claude Opus subagents per area + synthesizer)
Commit audited: e4475b8 "Enable x402 pay-per-review without channel onboarding"
Implementation surface: 36 files, +4586 lines across apps/web/
Audit completed: 2026-05-29

## TL;DR verdict

**NEEDS REVISION**

The Part A x402 endpoint, Part C aeon gate, Part D abuse infra, and Part E dual-rail isolation are substantially implemented and structurally sound — the load-bearing FR-E1 invariant (reviewPR rail-agnosticism) holds cleanly, and AC-7 (channel-rail no regression) passes with 107 tests green across 18 files. However, the SPEC-001 ship is gated by one **CRITICAL** blocker (Part B entirely unshipped — neither the antfleet/aeon-skills variant nor the aaronjmars/aeon registry PR exists, so the backend has no live consumer), and **8 MAJOR** issues spanning ordering invariants (FR-D1 rate-limit-after-verify), missing hard timeout (FR-D3 Layer 1), spec-vs-implementation drift on the 402 payload shape (FR-A2), a missing PAYMENT-RESPONSE header, and four gaps in automated AC coverage (AC-3, AC-6, AC-10, AC-11, AC-12). Finding counts: **1 CRITICAL / 11 MAJOR / 14 MINOR / 5 QUESTIONS**. Top three risks: (1) Part B unshipped — v1 cannot reach aeon users; (2) unbounded wall-clock execution because no 600s timeout exists around reviewPR — adversarial slow diffs burn unbounded budget; (3) AC-12 review-receipt page test missing — explicit spec-named file absent, two AC-12 copy assertions provably wrong in current code.

## Area verdicts

| Area | Verdict | Top concern |
|---|---|---|
| Part A — x402 endpoint | PARTIAL | FR-A2 payload shape diverges from literal spec; PAYMENT-RESPONSE header never attached to terminal poll response |
| Parts C+D — aeon gate + abuse infra | PARTIAL | FR-D3 Layer 1 (600s hard timeout) not implemented; rate-limit/cooldown run AFTER payment verify, violating FR-D1 ordering invariant |
| Part E — dual-rail + migration + worker | PASS | reviewPR byte-unchanged; channel-rail tests green; minor: cost_cap_exceeded bled into channel-rail refund module |
| FR-E2 receipt surface + manifest | PARTIAL | AC-12 integration test missing; receipt query hard-restricted to x402-rail; public copy elides aeon-gate prerequisite |
| AC coverage matrix | PARTIAL | 4 ACs missing automated coverage (AC-6, AC-10, AC-12); AC-11 is SQL-string-grep not real apply |
| Part B — skill variant + registry | FAIL | pr-review-antfleet-x402/ folder does not exist; aaronjmars/aeon skill-packs.json unchanged; AC-8 entirely missing |

## FR coverage matrix

### Part A — x402 endpoint

| FR | Status | Evidence | Notes |
|---|---|---|---|
| FR-A1 | implemented | apps/web/app/api/v1/review/x402/route.ts:115-117; apps/web/app/api/v1/review/x402/[jobId]/route.ts:20-26 | Routes mounted at spec'd paths; aeon gate via requireAeonContext (route.ts:126) |
| FR-A2 | partial | apps/web/lib/x402/facilitator.ts:49-72; route.ts:144-158 | `resource` is object not URL string; entries use `amount`/`extra` not `maxAmountRequired`/`description`; conforms to @x402/core v2 schema but diverges from spec literal; PAYMENT-RESPONSE header built (facilitator.ts:151) but never attached to terminal poll |
| FR-A3 | implemented | apps/web/lib/x402/facilitator.ts:102-105, 111; route.ts:191-201, 204-210 | Signer-extraction iterates permissive key list (facilitator.ts:243-247) — loosely typed but functional |
| FR-A4 | implemented | apps/web/lib/x402/env.ts:35-94 | Mainnet facilitator hard-coded to `api.cdp.coinbase.com/platform/v2/x402` vs spec's `facilitator.cdp.coinbase.com`; no startup reachability probe |
| FR-A4b | implemented | apps/web/lib/x402/env.ts:46-49, 121-126; route.ts:130-142, 221; facilitator.ts:128-130 | EIP-55 checksum via viem; treasury pinned at enqueue; settle refuses on mismatch |
| FR-A4c | implemented | apps/web/lib/x402/facilitator.ts:191-215; review-job-worker.ts:131-133 | 900s max window, 30s skew; persisted authorization read at settle |
| FR-A5 | implemented | apps/web/app/api/v1/review/x402/route.ts:214-235, 341-358; [jobId]/route.ts:32-64 | 202 + jobId + statusUrl + expectedDurationSec:180 |
| FR-A6 | implemented | apps/web/lib/github-files-public.ts:9-31; review-job-worker.ts:292; route.ts:303-321 | PublicRepoAccessError with code repo_not_accessible on 403/404 |
| FR-A7 | implemented | apps/web/app/api/v1/review/x402/route.ts:204-212, 323-335; SHA resolution 271-301 | sha256(wallet:owner/repo:pr:sha) matches spec exactly |
| FR-A8 | partial | apps/web/lib/review-job-worker.ts:400-402, 404-474; settle at 77 | `expired` terminal state not modeled; no expiry sweep |
| FR-A9 | implemented | route.ts:165-178, 222; review-job-worker.ts:77-78, 437-441 | Verify-then-defer-settle; no /void path; no auto-settle middleware |
| FR-A10 | implemented | apps/web/lib/x402/env.ts:50-56, 128-133; facilitator.ts:60-69; worker.ts:310-311 | 0.5 USDC default, 3x cost cap |

### Part B — skill variant + registry (separate repos)

| FR | Status | Evidence | Notes |
|---|---|---|---|
| FR-B1 | missing | gh api repos/antfleet/aeon-skills/contents/pr-review-antfleet-x402 → 404 | Skill folder not created upstream |
| FR-B2 | missing | No pr-review-antfleet-x402/SKILL.md in antfleet/aeon-skills | Blocked on FR-B1 |
| FR-B3 | missing | No pr-review-antfleet-x402/run.mjs | 600s EIP-3009 validBefore window not shipped client-side |
| FR-B4 | missing | No .outputs/pr-review-antfleet-x402.md template | Server emits paid_via='x402' but no consumer template |
| FR-B5 | missing | aaronjmars/aeon skill-packs.json unchanged as of 2026-05-29; no PR opened | One-line registry PR not opened |

### Part C — aeon gate

| FR | Status | Evidence | Notes |
|---|---|---|---|
| FR-C1 | implemented | apps/web/lib/x402/aeon-gate.ts:18-45; route.ts:126-127 | 403 + aeon_context_required before any payment work |
| FR-C2 | implemented | aeon-gate.ts:40-42, 58-77, 79-95 | HMAC-SHA256, 5min/30s skew, kid rotation via secrets array, timingSafeEqual |
| FR-C3 | partial | aeon-gate.ts:22-24 (X402_REQUIRE_AEON_CONTEXT flag); route.ts:126 (inline call, not middleware) | Env-flag removability works; "middleware" framing is inline function call, not Next.js middleware |

### Part D — abuse infra

| FR | Status | Evidence | Notes |
|---|---|---|---|
| FR-D1 | partial | apps/web/lib/x402/rate-limit.ts:15-42; route.ts:195-202; rate-limit.test.ts:5-22 | **ORDERING VIOLATION**: rate-limit check runs AFTER deps.verifyPayment (route.ts:167 vs 191), violating "rejected BEFORE x402 verification" invariant |
| FR-D2 | partial | rate-limit.ts:44-64; route.ts:183-189 | Cross-wallet caching correct (no wallet filter); same ordering issue; no cross-wallet test |
| FR-D3 | partial | review-job-worker.ts:309-329, 400-402; lib/x402/review-job-result.ts:7 | **Layer 1 (600s wall-clock timeout) NOT IMPLEMENTED** — no setTimeout/AbortController around reviewPR(); Layer 2 cost cap implemented but untested |

### Part E — dual-rail + migration + worker

| FR | Status | Evidence | Notes |
|---|---|---|---|
| FR-E1 | implemented | apps/web/lib/review-pipeline.ts byte-unchanged in e4475b8; rail dispatch lives in review-job-worker.ts:76-78, 132-135 | **Load-bearing PASS** — zero rail awareness in reviewPR; no `if (paymentRail === ...)` in pipeline |
| FR-E2 | partial | apps/web/app/receipts/review/[id]/page.tsx:1-145; queries.ts:1115-1165; review-job-worker.ts:374 | SQL hard-restricts to x402-rail (channel reviews 404); copy mismatches em-dash and "Payment not settled" literal |
| FR-E3 | implemented | apps/web/db/migrations/0028_review_jobs_x402.sql; schema.ts:544-571 | All required columns/indexes; no failure_mode CHECK (explicit); 6 extra columns for FR-A8/A9 settlement persistence |
| FR-E4 | implemented | 107 tests pass across 18 files in channel-rail gate set; only adjacent changes are paywall/gate.ts comment + refund.ts additive entry | Channel-rail observably unchanged |

## AC coverage matrix

| AC | Status | Test file | Notes |
|---|---|---|---|
| AC-1 | not_applicable | apps/web/scripts/x402-live-smoke.ts | Mainnet smoke is operator-gated; tooling exists |
| AC-1a | partial | apps/web/scripts/x402-live-smoke.ts | Smoke script supports Sepolia modes but no CI wiring auto-invokes it |
| AC-2 | covered | apps/web/app/api/v1/review/x402/route.test.ts:49-56; apps/web/lib/x402/aeon-gate.test.ts:29-50 | 403 + aeon_context_required asserted; "no budget consumed" implicit by early-exit |
| AC-3 | partial | apps/web/lib/review-job-queries.x402.test.ts | DB race-loss covered; spec-named idempotency.test.ts missing; route-level repeat-POST → no-double-settle never asserted |
| AC-4 | partial | apps/web/lib/review-job-worker.x402.test.ts; apps/web/lib/x402/facilitator.test.ts:78-99 | Settlement lifecycle covered; spec-named refund.test.ts missing; provider_error → no-settle path not directly asserted |
| AC-5 | partial | apps/web/lib/x402/rate-limit.test.ts:5-22 | Helper unit-tested; retryAfterSeconds value, HTTP 429 envelope, no-payment-consumed all untested |
| AC-6 | missing | (none) | No test for cross-wallet cooldown reuse — findRecentRepoShaJob has no dedicated test |
| AC-7 | covered | review-worker.test.ts; installations/[id]/review/*.test.ts; paywall/*.test.ts (all unmodified) | 107 tests pass; no channel-rail test modified |
| AC-8 | missing | (upstream — aaronjmars/aeon::skill-packs.json) | Setup precondition unmet; folder 404; no PR opened |
| AC-9 | covered | apps/web/lib/x402/aeon-gate.test.ts:52-59 | Flag-flip both branches asserted at unit level |
| AC-10 | missing | (none) | cost_cap_exceeded branch unreferenced in tests; no worker-level assertion that settle is skipped |
| AC-11 | partial | apps/web/db/migrations/0028.test.ts | SQL-string-grep only; no real apply; backfill + idempotency not executed |
| AC-12 | missing | (none — apps/web/app/receipts/review/[id]/page.test.tsx does not exist) | Spec-named test file absent; 6 Expected items entirely uncovered; copy bugs (em-dash, "Payment not settled") provably wrong |

## Findings by severity

### CRITICAL (1)

**1. Entire Part B (skill + registry) is unshipped — backend has no live consumer**
Area: Part B. Evidence: `gh api repos/antfleet/aeon-skills/contents/pr-review-antfleet-x402` → 404; aaronjmars/aeon skill-packs.json still `"skills": ["pr-review-antfleet"]`; zero open PRs touching antfleet/x402 on aaronjmars/aeon. Per spec § 11 build order lines 1636+1640, FR-B1–B4 and FR-B5 are the final two build steps before SPEC-001 reaches end users. Fix: ship two PRs — (1) antfleet/aeon-skills: create pr-review-antfleet-x402/ with SKILL.md + run.mjs (600s EIP-3009 window) + package.json + skills-pack.json bump; (2) aaronjmars/aeon: one-line PR applying the § 5.4 diff atomically (description + skills array).

### MAJOR (11)

**1. FR-D3 Layer 1 wall-clock timeout not implemented**
Area: Part D. Evidence: apps/web/lib/review-job-worker.ts:309 calls `await reviewPR(...)` with no setTimeout / AbortController / Promise.race. classifyError() (line 502) only catches errors whose message string contains 'timeout' — it does not enforce one. An adversarial slow diff burns unbounded budget. Fix: wrap reviewPR() in Promise.race against 600s timer (X402_MAX_TIMEOUT_SECONDS); on timeout throw with failureModeTag='timeout' so handleX402JobFailure leaves authorization unsettled.

**2. Rate-limit/cooldown checks happen AFTER payment verification — FR-D1 ordering invariant violated**
Area: Part D. Evidence: route.ts line 167 calls deps.verifyPayment, then lines 183/191 run cooldown + rate-limit. Spec § 4 FR-D1: "The 429 response does NOT consume payment (the request is rejected BEFORE x402 verification)." Fix: reorder so target resolution + cooldown + rate-limit run before verifyPayment; extract wallet from unverified PAYMENT-SIGNATURE if needed for rate-limit lookup.

**3. FR-A2 402 payload shape diverges from spec literal**
Area: Part A. Evidence: facilitator.ts:49-72 — `resource` is object {url,description,mimeType,serviceName,tags}; accepts[] uses `amount`/`extra` instead of spec's `maxAmountRequired`/`description`. Code passes isPaymentRequiredV2 from @x402/core but spec is out of sync. Fix: patch SPEC § FR-A2 to mirror @x402/core v2 schema (preferred — code is what facilitators consume) or restructure buildPaymentRequired to spec literal.

**4. PAYMENT-RESPONSE header never returned on terminal poll**
Area: Part A. Evidence: facilitator.ts:151 builds paymentResponseHeader; [jobId]/route.ts:43-57 returns only JSON body — no header attached. Spec FR-A2 step 4 mandates the header on terminal 2xx settling responses. Fix: in handleX402PollRequest, attach `PAYMENT-RESPONSE: <base64>` (rebuild from job.x402SettlementResponse) when status==='complete' && settlementStatus==='settled'; add to Access-Control-Expose-Headers; add poll-route test.

**5. AC-12 review-receipt-page integration test entirely missing**
Area: FR-E2. Evidence: spec § 8 AC-12 line 1461 explicitly names `apps/web/app/receipts/review/[id]/page.test.tsx`; `find apps/web -name page.test.* -path *review*` → empty. Seed fixtures exist but no consumer test. Fix: add page.test.tsx rendering the three seed-row shapes; assert all 6 Expected items including the failed-page "Payment not settled" string and em-dash copy.

**6. AC-6 cross-wallet cooldown branch untested**
Area: AC matrix. Evidence: route.ts:183-189 implements cooldownHit via findRecentRepoShaJob; route.test.ts mocks return vi.fn() but never exercises a non-null return. Fix: add route.test.ts case where deps.findRecentRepoShaJob returns existing complete job; assert 200 status, body mirrors existing job, deps.verifyPayment/createJob NOT invoked.

**7. AC-10 cost-cap branch untested for x402**
Area: AC matrix. Evidence: review-job-worker.ts:327 references failureModeTag='cost_cap_exceeded'; no test in review-job-worker.x402.test.ts exercises it. Fix: add processReviewJob case where reviewPR returns bundle with estimatedCostUsd > 1.5; assert facilitator.settlePayment NOT called, markX402JobFailedWithResultAndSettlement called with cost_cap_exceeded + not_settled.

**8. AC-3 idempotency repeat-POST → no-double-settle never asserted at route level**
Area: AC matrix. Evidence: spec-named idempotency.test.ts does not exist; route.ts:204-212 (findJobByIdempotencyKey → jobResponse) untested with non-null existing job. Fix: add route.test.ts case returning complete existing job from deps.findJobByIdempotencyKey; assert 200, deps.createJob NOT called, scheduleWorker NOT called, facilitator.settlePayment NOT invoked.

**9. AC-11 migration apply + backfill is string-grep, not real apply**
Area: AC matrix. Evidence: 0028.test.ts only reads SQL file text and greps. Item 2 (backfill payment_rail='channel' on existing rows) and Item 5 (idempotent re-apply) inferred from text, not executed. apply-migration-0028.ts --apply path itself untested. Fix: add real migration test with Postgres testcontainer at 0027; seed rows; run apply script; assert columns via information_schema; re-run to confirm idempotency.

**10. Receipt query forces payment_rail = 'x402'; channel-rail review_ids 404**
Area: FR-E2. Evidence: queries.ts:1155 `JOIN review_jobs j ON j.x402_review_id = r.review_id AND j.payment_rail = 'x402'`. FR-E2 table (spec line 865) describes the surface as rail-agnostic. Fix: either drop the predicate and LEFT JOIN (preferred) or amend spec to scope new surface to x402-rail only.

**11. Public positioning copy elides the aeon-gate restriction**
Area: FR-E2. Evidence: llms.txt advertises x402 pay-per-review with no mention of X-Aeon-Context; landing prose at apps/web/app/page.tsx:412-413 says "Public repos use x402 pay-per-review by default" without noting gate; aeon-gate defaults to required (returns 403). Non-aeon agents following copy hit 403 not 402. Fix: add one line in llms.txt and landing prose stating v1 access is restricted to aeon-ecosystem callers.

### MINOR (14)

**1. Mainnet facilitator URL contradicts spec table** — env.ts:7 vs spec § FR-A4 table. Pick canonical URL; align spec ↔ code.

**2. No startup reachability probe for X402_FACILITATOR** — Spec FR-A4 invariant 3 calls for 5s warn-only probe; not implemented.

**3. FR-A8 `expired` terminal state has no implementation** — No expiry sweep moves stale queued/running jobs to expired; poll handler defaults to 'pending'.

**4. Per-repo cooldown returns failed jobs as cached hits** — rate-limit.ts:50-61 includes 'failed' in cooldown status set; cross-wallet caller gets stale provider_error with status 200.

**5. No automated test for FR-D3 cost_cap_exceeded branch** — same as MAJOR #7 from worker-side angle; AC-10 lane.

**6. No automated test for FR-D2 cross-wallet cooldown cache hit** — findRecentRepoShaJob exported but untested; AC-6 lane.

**7. AC-2 'no rate-limit budget consumed' invariant has no explicit test** — Hold by construction (early exit); add deps assertions to be explicit.

**8. AC-5 rate-limit HTTP envelope + retryAfter calculation untested at route level** — Only helper tested; envelope/integer field unasserted.

**9. AC-1a not wired into CI even though spec gates "every CI build" on it** — Smoke script supports modes but no GitHub Actions invocation.

**10. x402 concept (cost_cap_exceeded) bled into channel-rail refund module** — paywall/refund.ts:18-23 dormant entries weaken FR-E1 isolation.

**11. Migration 0028 adds columns/indexes beyond FR-E3 enumeration** — 6 extra columns back FR-A8/A9 settlement; spec text under-specified.

**12. AC-12 expected copy mismatches** — page.tsx:69 emits ASCII hyphen vs em-dash; "Payment not settled" literal never rendered.

**13. Manifest is silent on aeon-gate prerequisite** — .well-known/antfleet.json/route.ts:23-52 advertises endpoints without access-scope field.

**14. Skill-side EIP-3009 600s window is primary control — server 900s ceiling is only floor** — Until run.mjs ships, real x402 calls use whatever default x402 client mints, reducing safety margin above 600s job timeout.

### QUESTIONS (5)

**1. Signer-extraction over loose key list** — facilitator.ts:243-247 probes 6 keys; EIP-3009 always uses authorization.from; tighten to eliminate attacker-controlled override risk.

**2. FR-C3 'middleware' framing is satisfied by an inline function call** — Env flag is load-bearing escape hatch; recommend (a) accept current design + spec clarification, or (b) lift gate into apps/web/middleware.ts.

**3. paywall/gate.ts comment changed from 'x402 invoice' to 'prepaid-channel top-up invoice'** — Vocabulary disambiguation, no behavior change; aligns with spec §1 "wallet-bound channel".

**4. Cross-rail review_id collision risk on review-level URL** — queries.ts:1155 GROUP BY + LIMIT 1 leaves resolution order undefined if same review_id ever shared across rails.

**5. Does skills-pack.json on antfleet/aeon-skills need a coordinated bump too?** — FR-B1 diagram implies; spec body doesn't enumerate field. Read current shape before opening PR; patch spec § 5.4.

## Load-bearing invariant verdict

- **Dual-rail isolation (FR-E1)**: PRESERVED — apps/web/lib/review-pipeline.ts is byte-unchanged in e4475b8 (verified `git diff --stat`); reviewPR() signature unwidened; zero `if (paymentRail === ...)` anywhere in pipeline; rail dispatch confined to review-job-worker.ts:76-78, 132-135.
- **Aeon-gate removability (FR-C3)**: PRESERVED — X402_REQUIRE_AEON_CONTEXT=false short-circuits at aeon-gate.ts:22-24 without touching route handler; aeon-gate.test.ts:52-59 asserts both branches. (Caveat: gate is inline call not Next.js middleware — semantic intent met, literal framing not.)
- **Channel-rail no regression (AC-7)**: PRESERVED — 107 tests pass across 18 files spanning the AC-7 gate set; only out-of-x402-tree changes are paywall/gate.ts comment update and paywall/refund.ts additive REFUNDABLE_FAILURE_MODES entry (dormant for channel rail).

## Pending work (not in this commit)

**Part B (CRITICAL — blocks v1 launch):**
1. Create antfleet/aeon-skills::pr-review-antfleet-x402/ folder with:
   - SKILL.md (FR-B2 frontmatter, env contract: AEON_X402_WALLET_PRIVATE_KEY, AEON_CONTEXT_TOKEN, ANTFLEET_API_BASE)
   - run.mjs (FR-B3 x402 client, hard-coded 600s EIP-3009 validBefore window, 10s/10min polling, ALERT_CHANNEL trigger)
   - .outputs/pr-review-antfleet-x402.md template (FR-B4: `**Paid via:** x402` header, review-level Receipt URL, no `**PR comment:**` line)
   - package.json
   - Bump skills-pack.json on antfleet/aeon-skills to declare the new skill
2. Open one-line PR to aaronjmars/aeon applying § 5.4 diff atomically (description rewrite + skills array bump). Coordinate with aaronjmars before merge.

**Operator decisions needed before mainnet (AC-1):**
- OQ-1: Aeon-context HMAC secret distribution mechanism + rotation cadence (24h overlap supported by code; no automation shipped)
- OQ-5: CDP API key provisioning for mainnet facilitator (env.ts:75-82 requires creds on mainnet)
- Treasury address EIP-55 confirmation + funding plan
- Sepolia smoke harness CI wiring (AC-1a) or explicit spec downgrade to manual gate

**Automated test gaps to close (post-launch acceptable but tracked):**
- apps/web/app/receipts/review/[id]/page.test.tsx (AC-12)
- Route-level idempotency repeat-POST test (AC-3)
- Cross-wallet cooldown test (AC-6)
- Cost-cap branch worker test (AC-10)
- Real migration apply test (AC-11)

## Ship recommendation

**NEEDS REVISION** — open FIX_SPEC_001_IMPL_V1_PROMPT.md with the following scope, prioritized:

**P0 (must land before mainnet):**
1. Implement FR-D3 Layer 1 600s timeout around reviewPR() (MAJOR #1)
2. Reorder route.ts: rate-limit + cooldown BEFORE verifyPayment (MAJOR #2)
3. Attach PAYMENT-RESPONSE header on terminal settled poll response (MAJOR #4)
4. Reconcile FR-A2 spec ↔ code (either patch spec to mirror @x402/core v2 or restructure buildPaymentRequired) (MAJOR #3)
5. Fix receipt query to LEFT JOIN review_jobs (drop x402 predicate) OR amend spec (MAJOR #10)
6. Add aeon-gate disclosure line to llms.txt + landing prose (MAJOR #11)

**P1 (must land before Part B PR opens):**
7. Add the 5 missing automated tests (AC-3, AC-6, AC-10, AC-11, AC-12)
8. Resolve mainnet facilitator URL discrepancy (MINOR #1)
9. Fix AC-12 copy mismatches (em-dash, "Payment not settled" literal) (MINOR #12)

**P2 (Part B build — separate PR sequence on separate repos):**
10. BUILD step 6: ship antfleet/aeon-skills::pr-review-antfleet-x402/ (CRITICAL)
11. BUILD step 7: open aaronjmars/aeon registry PR (CRITICAL)

Once P0 lands and Part B ships, AC-1/AC-1a operator smoke can run and the partnership can go live.
