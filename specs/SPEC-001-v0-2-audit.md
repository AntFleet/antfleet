# SPEC-001 v0.2 Audit Report

Auditor: Claude (Opus 4.7)
Spec audited: SPEC-001 v0.2 — `specs/SPEC-001-aeon-x402.md` (1488 lines)
Round-1 audit reference: `specs/SPEC-001-audit.md` (Codex / GPT-5)
Audit completed: 2026-05-29 UTC

## TL;DR verdict

**NEEDS REVISION** — 1 CRITICAL, 4 MAJOR, 3 MINOR, 1 QUESTION.

v0.2 closed 17 of the 18 round-1 findings cleanly and is a significant
quality jump over v0.1: terminal-state taxonomy now mirrors `refund.ts`
literally, refund semantics use defer-settle (no `/void` fiction), the
x402 v2 protocol surface is correct end-to-end (headers, CAIP-2 network,
@x402/* packages), the gate adds kid/skew/rotation, and a review-level
receipt surface is correctly carved out. The closure rate is ~94 %.

The single CRITICAL is a **channel-rail regression introduced by the
fix to C-2**: the migration 0028 SQL adds a `failure_mode` CHECK
constraint whose allow-list omits `insufficient_channel_balance`, which
is a real failure_mode value written by the production channel rail at
`route.ts:323/398/404`. The migration would either fail to apply on a
DB with existing billing failures, or apply successfully and then break
every future channel billing failure — directly violating FR-E4 and the
"no channel-rail regression" invariant. This is exactly the class of
finding the audit framework labels CRITICAL.

Top three risks:

1. Migration 0028 CHECK constraint is incomplete (CRITICAL — would
   break channel-rail billing path in production).
2. FR-A4 / FR-A2 contradicts itself on testnet: FR-A4 says "no testnet
   in production v1" but FR-A2's `accepts` example pins
   `eip155:8453` while AC-1a requires `eip155:84532`, and the spec
   never names which env var or config switch routes between them
   (MAJOR — ambiguous implementability).
3. Idempotency under x402 + the `payTo` env var (MAJOR — `ANTFLEET_X402_TREASURY`
   is referenced once with no FR defining ownership, custody, or what
   happens if the env var is unset at request time).

Dual-rail isolation invariant: **HOLDS** at the `reviewPR()` layer
(FR-E1 keeps the call rail-agnostic, prNumber is now a resolved int).
Aeon-gate removability invariant: **HOLDS** (FR-C3 unchanged, AC-9
added to enforce single-flag flip).

Round-1 closure rate: **17 / 18 fully closed, 1 partially closed (C-2
closure introduced the new CRITICAL above; the taxonomy itself is
correct, the migration SQL is wrong).**

v1 scope discipline: **HOLDS** — no Bankr listing, no sybil scoring,
no adversarial hardening, no private-via-x402, no PR-comment-in-x402.
§ 2.2 OOS list was expanded (true SHA-only review added) without
contracting any deferral.

---

## Findings by severity

### CRITICAL (1)

#### C2-1. Migration 0028 CHECK constraint omits `insufficient_channel_balance` — channel-rail regression

- Severity: CRITICAL
- Category: D (refund parity), F (backward compatibility), M (implementability), E (FR-E4 invariant)
- Spec ref: SPEC-001 § 5.3 (Migration 0028 SQL block) and FR-A8 table
- Quoted spec text (§ 5.3):
  ```sql
  ALTER TABLE review_jobs
    ADD CONSTRAINT review_jobs_failure_mode_check
    CHECK (
      failure_mode IS NULL OR
      failure_mode IN (
        'provider_error',
        'timeout',
        'internal',
        'user_input',
        'validation',
        'cost_cap_exceeded'
      )
    );
  ```
- What's wrong: The production channel rail writes `failure_mode = 'insufficient_channel_balance'` at
  `apps/web/app/api/v1/installations/[id]/review/route.ts:323` (top-level helper-passed string),
  `route.ts:398` and `route.ts:404` (`markBillingJobFailed(..., "insufficient_channel_balance", ...)`).
  No existing CHECK constraint exists on `failure_mode` today (verified — `0024_review_jobs.sql:18`
  declares `failure_mode text` with no constraint; 0027 only touches `status`).
  The migration 0028 SQL therefore (a) will fail to apply on any DB instance with one
  or more historical billing failures, AND (b) if it applies on a clean DB, will then
  reject every future `markBillingJobFailed` call from the channel rail, causing the
  channel rail to throw at billing time and leaving review_jobs rows stuck in
  `billing_pending`. Either outcome is a CRITICAL channel-rail regression and a
  direct FR-E4 violation ("existing channel-rail integration tests pass without
  modification").
- Confidence: HIGH (verified against `route.ts` source, `0024_review_jobs.sql`, and
  `0027_review_jobs_billing_pending.sql`).
- Why this matters: Migration 0028 is FR-E3 and AC-11 — by spec these gate every
  other AC. Applying this migration as written breaks production. The whole point
  of fix C-2 was to align taxonomy with production; the closure overshot and
  removed a value production actually uses.
- Realist check: Worst case is the migration fails on production apply, deploy is
  blocked, channel rail unaffected. Best case the apply gets staged and caught at
  AC-7 (regression test). Detection is fast (minutes). But the spec ships a SQL
  block that, if executed verbatim per § 5.3 + AC-11, breaks channel-rail billing.
  Severity stays CRITICAL — the document is the authority and an executor following
  it will write a broken migration.
- Fix:
  1. Add `'insufficient_channel_balance'` (and any other production literal — grep
     `apps/web/` for failure_mode string literals before finalizing) to the CHECK
     allow-list, OR
  2. Drop the CHECK-constraint enforcement entirely from migration 0028 and leave
     `failure_mode text` unconstrained as it is in 0024 (only add the
     `caller_wallet`, `payment_rail`, and indexes — that's all FR-E3 actually
     requires). Recommended: option 2, because the production code already
     gatekeeps `failure_mode` values at the application layer (`refund.ts`
     `REFUNDABLE_FAILURE_MODES`); adding a DB-level CHECK introduces a tight
     coupling that any future failure mode (legitimate or otherwise) must
     remember to update.
  3. If option 1 is taken, also document in FR-A8 that `insufficient_channel_balance`
     is a valid channel-rail-only terminal failure_mode (currently the FR-A8 table
     does not mention it, creating a spec/code mismatch in the opposite direction).

### MAJOR (4)

#### C2-2. `ANTFLEET_X402_TREASURY` env var introduced with no ownership or fallback semantics

- Severity: MAJOR
- Category: A (x402 protocol compliance), M (implementability), G (API stability)
- Spec ref: SPEC-001 FR-A2 (`payTo` field) and FR-A10 (env vars)
- Quoted spec text (FR-A2): `"payTo": "<antfleet treasury address from ANTFLEET_X402_TREASURY env>"`
- What's wrong: `ANTFLEET_X402_TREASURY` appears once in the spec, with no companion
  paragraph specifying: (a) what address format is expected (checksummed? lowercased
  EIP-55? CAIP-10?), (b) who owns the wallet (multisig? hot wallet? CDP-managed?),
  (c) what the endpoint MUST do if the env var is missing or malformed (500? 503?
  fail-closed? fall back to channel-rail `ANTFLEET_DEPOSIT_ADDRESS` from project
  memory?), and (d) whether settle calls atomically write to the same address that
  was advertised in the 402 (an obvious replay-tampering vector if not pinned).
  FR-A10 ("Pricing") covers `X402_REVIEW_PRICE_USDC` but not `ANTFLEET_X402_TREASURY`.
- Confidence: HIGH.
- Why this matters: An executor building from this spec has no way to know whether
  `ANTFLEET_X402_TREASURY` is meant to be the same address used today by the
  channel rail (project memory says channel uses `ANTFLEET_DEPOSIT_ADDRESS`,
  unset in prod as of 2026-05-21). Treasury custody is a security boundary,
  not a configuration detail.
- Fix: Add a FR-A4 sub-clause (or new FR-A4b) titled "Treasury address handling"
  that specifies: required env var name, expected format, behavior on missing
  (recommend: 5xx with `code: 'treasury_unconfigured'` returned to caller, not
  silent fallback), and whether it can be the same as the channel-rail deposit
  address (recommend: yes, same hot-wallet, documented).

#### C2-3. Testnet/mainnet routing under-specified (FR-A4 vs FR-A2 vs AC-1a)

- Severity: MAJOR
- Category: A (x402), H (internal consistency), I (AC measurability)
- Spec ref: FR-A4 vs FR-A2 vs AC-1a
- Quoted spec text:
  - FR-A4: `"USDC on Base mainnet only ... asset address 0x833589...02913, amount 500000"` and
    `"Staging MAY substitute Base Sepolia USDC and eip155:84532 only for AC-1a"`.
  - FR-A2 example: `"network": "eip155:8453"`, `"asset": "0x833589...02913"` (hard-coded mainnet).
  - AC-1a: requires staging `X402_FACILITATOR=x402.org` and `X402_NETWORK=eip155:84532`.
- What's wrong: The spec hardcodes the mainnet asset address and network in the
  FR-A2 example payload but expects staging to substitute Sepolia per AC-1a. It
  never specifies (a) the env-var contract that switches between them
  (`X402_NETWORK` is mentioned only inside AC-1a setup, never defined as a
  first-class env var alongside `X402_REVIEW_PRICE_USDC`), (b) which Sepolia
  USDC asset address staging uses (the spec says "Base Sepolia USDC" without
  naming the contract — Circle's Sepolia USDC is `0x036C...3e7Bf238` which is
  not in the spec), or (c) what happens if the env values are inconsistent
  (e.g., mainnet facilitator + testnet asset). FR-A4 + FR-A2 imply config is
  baked at deploy time but `accepts[].asset` and `accepts[].network` must be
  produced by request-time code, so something must read them from config.
- Confidence: HIGH (FR-A2 / FR-A4 / AC-1a comparison; project memory does not
  pin a Sepolia USDC asset).
- Why this matters: An executor will either copy the FR-A2 example literally
  (breaking AC-1a on staging) or invent a config layer (breaking the spec's
  "matches example exactly" implicit contract). The audit prompt flagged
  AC-1a as a deterministic test gate; the test cannot pass without a defined
  env-var routing layer.
- Fix: Add to FR-A2 + § 5.1 endpoint contract: define `X402_NETWORK`
  (CAIP-2 string), `X402_USDC_ASSET` (address per network), `X402_FACILITATOR`
  (URL or label), all read at startup. Specify defaults (mainnet) and the
  staging override (Sepolia + x402.org facilitator). Move the FR-A2 example
  to use placeholder tokens (`${X402_NETWORK}`, `${X402_USDC_ASSET}`) so the
  spec reads consistently regardless of environment.

#### C2-4. EIP-3009 `validAfter`/`validBefore` window is asserted but not defined where it must be set

- Severity: MAJOR
- Category: A (x402), D (refund parity), M (implementability)
- Spec ref: FR-A9 step 2 and FR-B3 (skill runner) and AC-4
- Quoted spec text (FR-A9 step 2): `"the authorization is bounded by its own validAfter / validBefore window (set to ~10 minutes by the skill runner) and expires unused"`.
- What's wrong: The defer-settle refund mechanism is load-bearing on the
  authorization actually expiring before settle. The spec asserts a "~10
  minute" window "set by the skill runner" but: (a) FR-B3 (the skill runner
  contract) does NOT mention setting `validAfter`/`validBefore` at all — it
  just says the runner constructs the x402 client and submits the request;
  (b) `@x402/core` middleware default windows are not specified in the spec
  (the docs WebFetch didn't surface a default); (c) the worker decision tree
  in FR-A8 assumes "no settle = no charge" but if the middleware mints a
  60-minute or 24-hour authorization window by default, and the worker takes
  20 minutes to fail (e.g., a stuck job), the caller's authorization is
  still valid and a subsequent admin-triggered settle (or a malicious replay
  by anyone who captured the signature) could settle long after the worker
  decided not to. This is a finance bug surface.
- Confidence: MEDIUM (the 10-minute number is asserted in the spec; the
  enforcement is not). Could be downgraded if @x402/core actually clamps
  windows at the middleware layer — I could not verify this from docs.
- Why this matters: The whole defer-settle design rests on bounded
  authorization windows. If the window is wrong by default and the spec
  doesn't enforce setting it, refund-via-expiry becomes refund-via-hope.
- Fix: (a) Move the window-setting requirement from a parenthetical in
  FR-A9 into an explicit FR-B3 step ("The runner MUST set
  `validAfter = now` and `validBefore = now + 600s` on every payment
  authorization"); (b) add a server-side enforcement in FR-A2/FR-A9: the
  endpoint MUST reject any authorization with `validBefore - now > 900`
  (15-minute hard ceiling) at /verify time; (c) extend AC-4 to assert
  the on-chain authorization expires before the worker emits its
  not-settle decision (timing test).

#### C2-5. AC-1a/AC-10/AC-11/AC-12 require new infrastructure that the spec does not commit AntFleet to building

- Severity: MAJOR
- Category: I (AC measurability), M (implementability)
- Spec ref: AC-1a (`antfleet/x402-fixture` repo), AC-10 (forced-large-diff
  fixture), AC-11 (`apply-migration-0028.ts --apply`), AC-12 (review-level
  receipt page)
- Quoted spec text examples:
  - AC-1a: `"TARGET=\"PR=1;REPO=antfleet/x402-fixture\""`
  - AC-10: `"a PR with ~50K lines changed, intentionally constructed to exceed inference budget"`
  - AC-11: `"Run apply-migration-0028.ts --apply (per project convention)"`
- What's wrong: Four ACs depend on artifacts/tooling that don't exist in the
  current repo or aren't named in the spec: (a) `antfleet/x402-fixture` is
  not in `/Users/augstar/projects/antfleet` (verified — not a known dir;
  no spec FR creates it); (b) the AC-10 fixture PR with 50k changed lines
  has no creation FR; (c) `apply-migration-0028.ts` is the project
  convention per memory but no FR commits to writing it; (d) AC-12 requires
  `apps/web/app/receipts/review/[id]/page.tsx` which is created by FR-E2
  but the FR doesn't enumerate the test fixture rows AC-12 needs. None of
  these are blockers individually, but together they mean "build-complete"
  per § 8 header requires deliverables not in the FR list.
- Confidence: HIGH.
- Why this matters: The audit prompt requires "every AC tests at least
  one FR." AC-1a, AC-10, AC-11, AC-12 each test FRs (A2/A5/D3/E2/E3) but
  the FRs do not commit AntFleet to produce the test substrates. An
  executor implementing the FRs literally will not have a route to pass
  the ACs.
- Fix: Add a § 5.5 "Test infrastructure dependencies" subsection that
  lists the four artifacts explicitly (fixture repo, fixture PR, migration
  apply script, three seed rows for AC-12) and treats them as in-scope
  deliverables in § 11 Build steps. Alternatively, downgrade these ACs
  from gating to "post-ship verification" and rename § 8 header to
  acknowledge the split.

### MINOR (3)

#### C2-6. Change-log v0.2 omits a per-finding mapping for fix M-7's surface name change

- Severity: MINOR
- Category: H (internal consistency)
- Spec ref: Change log v0.2 line 20 and FR-E2
- Quoted spec text (change log line 20): `"M-7: Add a new review-level receipt surface at /receipts/review/{review_id} while leaving finding receipts untouched."`
- What's wrong: The change log entry is accurate, but FR-E2 also says
  `"The receipt URL returned to x402 callers in the job's terminal-state
  payload is the review-level URL"` — which is a behavior change for x402
  callers that the change log doesn't surface. Not wrong; just incomplete.
  A new reader who only skims the change log won't realize x402 receipts
  in job-state payloads are review-level URLs, not finding-level.
- Fix: Add a sub-bullet under M-7 in change log: "and x402 job terminal
  payload includes the review-level URL by default."

#### C2-7. AC-7 says "tests pass without modification" but AC-7 itself is a new test layer

- Severity: MINOR
- Category: I (AC measurability), H (consistency)
- Spec ref: AC-7
- Quoted spec text: `"How to verify: Existing channel-rail integration tests (route.test.ts, review-worker.test.ts, etc.) pass without modification."`
- What's wrong: AC-7's verification is to run existing tests, but the
  v0.2 spec doesn't enumerate which tests are the gate set. Worse,
  `review-worker.test.ts` and `route.test.ts` are not verified to exist
  in the current repo at the named paths (round-1 audit didn't verify
  this either; v0.2 inherited the wording). At minimum the spec should
  list the exact test files that must pass green.
- Fix: Replace "etc." with the actual file glob (e.g., `apps/web/**/*.test.ts`
  excluding `apps/web/lib/x402/`).

#### C2-8. § 7 placeholder retains v0.1 wording but should mention v0.2 audit

- Severity: MINOR
- Category: H (internal consistency)
- Spec ref: § 7 heading and body
- Quoted spec text (§ 7 heading): `"## 7. Phase findings encoded in SPEC-001 v0.1"`
- What's wrong: After a v0.2 bump that closed 17 audit findings, § 7
  still says "SPEC-001 v0.1" in its heading and "no prior findings to
  encode." The round-1 findings ARE prior findings that should be
  encoded here per the macprovider pattern the spec's body explicitly
  invokes.
- Fix: Rename § 7 heading to "Phase findings encoded in SPEC-001". Move
  a short summary of round-1 audit closures (with finding IDs) into the
  body, citing the change log v0.2 entries.

### QUESTIONS (1)

#### Q2-1. Are `@x402/core`, `@x402/express`, `@x402/evm` versions stable enough to pin today?

- Severity: QUESTION
- Category: M (implementability)
- Spec ref: § 6.1
- Quoted spec text: `"Pin specific versions in package.json"` and `"All packages listed MUST be verified to exist on the npm registry"`
- What's wrong: x402 docs confirm these are the official package families,
  but the spec gates implementation on npm registry verification without
  doing the verification in the spec itself. v0.1 round-1 Q-4 raised
  this and the fix prompt said "gate impl on verification." That
  gating is now in § 6.1. Still a question because the audit can't
  confirm version stability without an npm probe.

---

## Round-1 closure matrix

| Round-1 ID | Round-1 severity | v0.2 status | Notes |
|---|---|---|---|
| C-1 | CRITICAL | **CLOSED** | FR-A6 now says `failure_mode='user_input'` settles, charges caller; consistent with FR-A8. |
| C-2 | CRITICAL | **PARTIAL** | Taxonomy text correct (FR-A8 mirrors refund.ts), but the migration 0028 SQL that locks it in introduces the new CRITICAL C2-1 above (CHECK omits `insufficient_channel_balance`). |
| M-1 | MAJOR | **CLOSED** | x402 v2 throughout: `x402Version: 2`, `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`, `eip155:8453`, `@x402/*` deps. Verified against docs.x402.org migration guide. |
| M-2 | MAJOR | **CLOSED** | FR-A9 rewritten as verify-then-defer-settle; no `/void`, no `pending_refunds`; explicit middleware-must-be-verifyOnly clause. (Partial dependency on C2-4 — window enforcement weak — but the design choice is correct.) |
| M-3 | MAJOR | **CLOSED** | Header `Depends on:` says `schema head 0027`; FR-E3 says next migration 0028; § 5.3 heading "Migration 0028". |
| M-4 | MAJOR | **CLOSED** | FR-A7 specifies SHA must resolve to exactly one open PR; § 2.2 OOS adds true-SHA-only review; FR-E1 says `prNumber` always integer. Matches production behavior in `route.ts:584-619`. |
| M-5 | MAJOR | **CLOSED** | FR-A5 returns `{jobId, statusUrl, expectedDurationSec}` matching `route.ts:447-453`. |
| M-6 | MAJOR | **CLOSED** | FR-C1/FR-D1 use `{error:{code,message}}` envelope; FR-C1 cites `jsonError()` helper at `lib/api-v1/responses.ts`. |
| M-7 | MAJOR | **CLOSED** | FR-E2 carves new review-level surface; finding-level unchanged. OQ-4 marked CLOSED. AC-12 covers rendering. |
| M-8 | MAJOR | **CLOSED** | FR-C2 adds `kid`, 30s future skew, 24h overlapping rotation. (Could harden further per round-1 OQ-1, but the v1 contract is now defined.) |
| M-9 | MAJOR | **CLOSED** | FR-D3 is now post-run accounting + hard 600s timeout; explicitly documents the absorbed-burn risk and v2 deferral. |
| m-1 | MINOR | **CLOSED** | All 10 occurrences of "Aeon-Context" carry `X-` prefix (verified by grep). |
| m-2 | MINOR | **CLOSED** | AC-7 step 2 now references channel idempotency, not FR-A7. |
| m-3 | MINOR | **CLOSED** | `siwe` removed from dep table; appears only in note at end of § 6.1. |
| Q-1 | QUESTION | **CLOSED** | AC-1a (Sepolia smoke) added before AC-1 (mainnet smoke). |
| Q-2 | QUESTION | **CLOSED** | FR-E2 documents `paid_via` as optional/additive; consumer compat is operator responsibility. |
| Q-3 | QUESTION | **CLOSED** | FR-D2 has full "Cross-wallet caching is intentional" paragraph with three-point rationale. |
| Q-4 | QUESTION | **CLOSED** (process-gated) | § 6.1 ends with "MUST be verified to exist on the npm registry and pinned." |

**Closure rate: 17/18 fully closed, 1 partial (C-2 — taxonomy closed,
migration SQL introduced new CRITICAL).**

---

## Cross-reference resolution matrix

| Source location | Reference target | Auditor verdict |
|---|---|---|
| Header `Depends on:` | schema head 0027 | Resolves — verified via `ls apps/web/db/migrations/` |
| Header `Depends on:` | Coinbase CDP x402 facilitator (mainnet) | Resolves — confirmed at docs.cdp.coinbase.com/x402/network-support |
| FR-A2 | x402 v2 protocol — `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`/`eip155:8453` | Resolves — confirmed via docs.x402.org/guides/migration-v1-to-v2 |
| FR-A2 | `ANTFLEET_X402_TREASURY` env var | **Broken** — no FR defines it (see C2-2) |
| FR-A4 | Asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Resolves — Circle USDC on Base mainnet |
| FR-A4 | `eip155:84532` (staging Sepolia) | Resolves — Base Sepolia chain id |
| FR-A4 | Sepolia USDC asset address | **Broken** — not named (see C2-3) |
| FR-A5 | Existing async response shape | Resolves — verified against `route.ts:447-453` |
| FR-A6 | `apps/web/lib/github-files-public.ts` (new) | Partial — new file, acceptable per spec |
| FR-A8 | `apps/web/lib/paywall/refund.ts` REFUNDABLE_FAILURE_MODES | Resolves — `{provider_error, timeout, internal}` matches FR-A8's no-settle set |
| FR-A8 | `insufficient_channel_balance` failure_mode | **Broken (omission)** — production uses it; spec table doesn't mention it (see C2-1) |
| FR-A9 | EIP-3009 validAfter/validBefore | Partial — referenced, not enforced (see C2-4) |
| FR-C1 | `jsonError()` helper at `apps/web/lib/api-v1/responses.ts` | Resolves — verified |
| FR-C2 | `AEON_GATE_SECRETS` env (JSON array) | Resolves — implementable |
| FR-D3 | `estimateRunCost()` at `apps/web/lib/review-pipeline.ts` | Resolves — verified at `review-pipeline.ts:104` |
| FR-E1 | `reviewPR()` signature is rail-agnostic | Resolves — verified at `review-pipeline.ts:53-59` (takes `ChangedFile[]`, owner, repo, prNumber:number, mode) |
| FR-E2 | New `/receipts/review/{review_id}` page | Resolves (new) |
| FR-E2 | Existing `/receipts/{finding_id}` untouched | Resolves — verified at `app/receipts/[id]/page.tsx` |
| FR-E3 | Migration 0028 SQL | **Broken** — CHECK constraint regression (see C2-1) |
| § 5.3 | `apply-migration-0028.ts --apply` | Partial — convention exists per memory; no FR creates the script (see C2-5) |
| § 5.4 | `aaronjmars/aeon/skill-packs.json` | Resolves (round-1 auditor confirmed) |
| § 6.1 | `@x402/core`, `@x402/express`, `@x402/evm` | Partial — names confirmed via docs.x402.org; specific versions not pinned in spec (see Q2-1) |
| § 8 AC-1a | `antfleet/x402-fixture` repo | **Broken** — not created by any FR (see C2-5) |
| § 8 AC-11 | `apply-migration-0028.ts` | Partial — same (see C2-5) |
| Appendix A | `bankrskills-bench` (public fork) | Not verified (no proprietary browsing) |

---

## OQ disposition (round-1 OQs as carried into v0.2)

| OQ | v0.2 state | Disposition |
|---|---|---|
| OQ-1 (gate token mechanism) | Unchanged | Real operator/partner decision (Aaron confirmation). v0.2 added kid+skew+rotation so the mechanism is concrete enough to ship even without confirmation. **Keep open.** |
| OQ-2 (rate limit value) | Unchanged | Real risk-tolerance decision. **Keep open.** |
| OQ-3 (per-repo cooldown) | Unchanged | Real product decision. **Keep open.** |
| OQ-4 (receipt namespace) | **CLOSED in v0.2** | Correctly closed; rationale cites `db/queries.ts:1053` and `app/receipts/[id]/page.tsx:21`. |
| OQ-5 (facilitator choice) | Updated | Current position: CDP mainnet + verifyOnly; x402.org testnet. Verified against docs.cdp.coinbase.com. Operator action remains (license/quota verification). **Keep open.** |

No new OQs introduced by v0.2 (the v0.2 fixes baked the operator
decisions in as defaults per the fix prompt).

---

## AC coverage matrix (v0.2)

| FR | AC coverage | Verdict |
|---|---|---|
| FR-A1 endpoint shape | AC-1, AC-1a, AC-2 | Covered |
| FR-A2 x402 v2 payload | AC-1, AC-1a | Partial — no explicit schema-conformance assert |
| FR-A3 stateless wallet identity | AC-1, AC-1a, AC-3, AC-5 | Covered |
| FR-A4 USDC on Base mainnet (+ Sepolia for AC-1a) | AC-1, AC-1a | Partial — see C2-3 |
| FR-A5 async response shape | AC-1, AC-1a | Covered |
| FR-A6 public-repo fetch + `user_input` private-repo path | AC-1, AC-1a | Partial — no dedicated private-repo / 404-fetch AC |
| FR-A7 idempotency (incl. SHA→PR resolution) | AC-3 | Partial — only PR-input idempotency path tested; SHA-only-input ambiguous/zero-match paths untested |
| FR-A8 terminal-state taxonomy | AC-4, AC-10 | Partial — only `provider_error` and `cost_cap_exceeded` exercised; `timeout`/`internal`/`user_input`/`validation` untested |
| FR-A9 deferred settle | AC-3, AC-4 | Partial — verifyOnly middleware config not directly asserted (FR-A9 step 5 names it as an AC-4 obligation but AC-4 itself doesn't restate it) |
| FR-A10 pricing | AC-1, AC-1a | Covered |
| FR-B1–B4 skill | AC-1, AC-1a | Partial |
| FR-B5 registry PR | AC-8 | Covered |
| FR-C1 gate header | AC-2, AC-9 | Covered |
| FR-C2 token mechanism + rotation | AC-2 | Partial — no rotation-window AC (kid old→new overlap) |
| FR-C3 removability | AC-9 | Covered (NEW in v0.2) |
| FR-D1 rate limit | AC-5 | Covered |
| FR-D2 per-repo cooldown + cross-wallet cache | AC-6 | Covered |
| FR-D3 cost cap | AC-10 | Covered (NEW in v0.2) |
| FR-E1 pipeline reuse | AC-7 | Partial — no direct assertion that `reviewPR()` signature stayed rail-agnostic |
| FR-E2 receipt surfaces | AC-1, AC-1a, AC-4, AC-12 | Covered (AC-12 NEW in v0.2) |
| FR-E3 migration | AC-11 | Covered (NEW in v0.2) — BUT see C2-1; migration SQL is broken |
| FR-E4 no channel regression | AC-7 | Covered |

**Round-1 gaps closed:**
- FR-C3 → AC-9 added ✓
- FR-D3 → AC-10 added ✓
- FR-E3 → AC-11 added ✓
- FR-E2 review-level surface → AC-12 added ✓

**New gaps (v0.2 fixes opened a few partials):**
- FR-A8 full matrix — only 2 of 7 terminal states exercised
- FR-A7 SHA-only resolution branches — zero/ambiguous-match paths untested
- FR-C2 rotation overlap — no AC for the 24h overlap window
- FR-A9 verifyOnly middleware configuration — referenced as AC-4 obligation but not in AC-4 expected list

These are MINOR coverage gaps individually; the cluster is worth a
mention but not a finding (the spec explicitly says "AC-1 (incl AC-1a),
AC-2 through AC-12 must ALL pass" — full taxonomy testing can ride
inside AC-4/AC-10).

---

## Suggested fix order

1. **C2-1 (CRITICAL)** — Rewrite migration 0028 SQL to either include
   `insufficient_channel_balance` in the CHECK allow-list or drop the
   CHECK constraint entirely. Highest priority — blocks all of AC-11
   and FR-E4. Recommend dropping the CHECK; production gatekeeps at the
   application layer already.
2. **C2-2 (MAJOR)** — Define `ANTFLEET_X402_TREASURY` env var contract
   in a new FR-A4b or extended FR-A10. Custody and fallback semantics
   are security-relevant.
3. **C2-3 (MAJOR)** — Add `X402_NETWORK` / `X402_USDC_ASSET` /
   `X402_FACILITATOR` env vars to FR-A2/§ 5.1; replace hard-coded
   mainnet values in the FR-A2 example with placeholders.
4. **C2-4 (MAJOR)** — Move EIP-3009 `validAfter`/`validBefore` window
   from a parenthetical into an explicit FR-B3 step + server-side
   FR-A2/FR-A9 hard ceiling. Extend AC-4 with the timing assertion.
5. **C2-5 (MAJOR)** — Add § 5.5 "Test infrastructure dependencies"
   enumerating the four artifacts (fixture repo, fixture PR, migration
   apply script, AC-12 seed rows) and committing AntFleet to producing
   them.
6. **C2-6 / C2-7 / C2-8 (MINOR)** — Apply alongside the above; trivial
   wording edits.

If only C2-1 is fixed and the MAJORs are deferred to a v0.3 round, the
spec is buildable; the MAJORs are correctness/clarity concerns that
will produce confused implementations and likely re-flag at impl
review. Recommend: ship a v0.3 narrow patch addressing C2-1 + C2-2 + C2-3
+ C2-4 + C2-5 + minors. Estimated patch size: 80-150 spec lines (much
smaller than v0.2 was).

After v0.3, re-run **narrow** audit (only the changed sections — C-1
in round-1 was a process trigger for full re-audit; v0.2 closed the
two CRITICALs at the requirements level and the new CRITICAL is a
single SQL block).
