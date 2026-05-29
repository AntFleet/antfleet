# SPEC-001 Audit Report

Auditor: Codex CLI (GPT-5)
Spec audited: SPEC-001 v0.1 commit e7d0924460e19244e1e745fdff5af775551ea08f
Audit completed: 2026-05-28T23:25:44Z

## TL;DR verdict

NEEDS REVISION

I found 2 CRITICAL findings, 9 MAJOR findings, 3 MINOR findings, and 4 QUESTIONS. The top risks are: terminal/refund semantics do not actually line up with the production channel rail, the x402 protocol surface mixes legacy v1 assumptions with current official x402 v2 SDK and facilitator docs, and the receipt model assumes review-level public receipts while the current app routes `/receipts/{id}` through finding IDs. Dual-rail isolation mostly holds at the `reviewPR()` layer, but not at the surrounding worker/job contracts yet. Aeon-gate removability holds as an architectural intent, but the token mechanics need clock-skew and rotation rules before build.

## Findings by severity

### CRITICAL (2)

#### C-1. Private repo x402 failures are both `user_error` and refunded

- Severity: CRITICAL
- Category: A, D
- Spec ref: SPEC-001 § 4 Part A FR-A6, FR-A8, FR-A9
- Quoted spec text: "`repo private` ... status `user_error` ... `Payment is refunded per FR-A9`" and "`user_error` ... Settlement yes, Refund no"
- What's wrong: FR-A6 says private repo access failure is a user error and refunded. FR-A8/FR-A9 say user error settles and does not refund. The audit brief explicitly requires `user_error` not to refund. This creates a financial-semantic contradiction in a core path.
- Fix direction: Keep private repo / inaccessible public fetch as `user_error` with no refund, or introduce a different terminal class only if the operator intentionally wants a refund. Do not leave one clause saying refunded and another saying settled.

#### C-2. Terminal-state taxonomy does not match the production channel rail

- Severity: CRITICAL
- Category: D, F, M
- Spec ref: SPEC-001 § 4 Part A FR-A8-FR-A9
- Quoted spec text: "`internal_error` ... Refund yes" and "`user_error` ... Refund no"
- What's wrong: Existing channel jobs store `status = 'failed'` plus `failure_mode`, not terminal statuses named `provider_error`, `timeout`, `internal_error`, or `user_error`. Existing refund code refunds only `provider_error`, `timeout`, and `internal`; it uses non-refundable `user_input` / `validation`, not `user_error` (`apps/web/lib/paywall/refund.ts:16-30`). Existing schema 0024 only allows `queued`, `running`, `complete`, `failed`, and `expired` (`apps/web/db/migrations/0024_review_jobs.sql:16`). Implementing the spec literally would bypass the existing refund allow-list for `internal_error` and invent a parallel taxonomy.
- Fix direction: Specify canonical storage as `status='failed'` with `failure_mode in ('provider_error','timeout','internal','user_input','validation',...)`, then define x402 API response labels as a mapping if needed. Add `cost_cap_exceeded` to the allow-list deliberately.

### MAJOR (9)

#### M-1. x402 protocol surface mixes v1 payloads with current v2 official docs and packages

- Severity: MAJOR
- Category: A, M
- Spec ref: SPEC-001 § 4 Part A FR-A2; § 6.1
- Quoted spec text: "`x402Version`: 1", "`X-PAYMENT`", "`network`: `base`", and dependency "`@coinbase/x402`"
- What's wrong: Current x402 docs describe v2 as using `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, `x402Version: 2`, and CAIP-2 networks like `eip155:8453`. The same docs show the current TypeScript packages as `@x402/core`, `@x402/express`, `@x402/fetch`, and `@x402/evm`, not `@coinbase/x402`. Coinbase CDP docs say the CDP facilitator supports both v1 and v2, but the spec does not pin a legacy v1 SDK or explain why v1 is chosen.
- Fix direction: Either move the spec to x402 v2 end-to-end, or explicitly pin legacy v1 package names, header names, network string, facilitator endpoint, and compatibility tests. Do not leave implementers to infer which generation is normative.
- Sources: https://docs.x402.org/core-concepts/http-402, https://docs.x402.org/guides/migration-v1-to-v2, https://docs.cdp.coinbase.com/x402/network-support

#### M-2. Refund-via-void is underspecified against the facilitator model

- Severity: MAJOR
- Category: A, D
- Spec ref: SPEC-001 § 4 Part A FR-A9; § 10 OQ-5
- Quoted spec text: "calls the facilitator's `void` (or equivalent) step"
- What's wrong: Official x402 docs describe facilitator `/verify` and `/settle`; I did not find a standard `/void`. With EIP-3009, not settling a still-valid authorization may be the practical "void", but that is different from a facilitator API operation. If implementers use middleware, settlement usually happens before the handler returns, which makes the refund fallback mandatory rather than exceptional.
- Fix direction: Specify the lifecycle precisely: verify only before enqueue, persist the signed payload/authorization, settle only after terminal success/non-refundable user error, and let unused authorizations expire. If using auto-settling middleware, add the `pending_refunds` schema and AC coverage now.
- Sources: https://developers.cloudflare.com/agents/agentic-payments/x402/, https://docs.x402.org/schemes/exact

#### M-3. Migration number and schema-head assumptions are stale

- Severity: MAJOR
- Category: C, M
- Spec ref: SPEC-001 header; § 4 Part E FR-E3; § 5.3
- Quoted spec text: "schema head 0024" and "The next migration (0025, conventionally)"
- What's wrong: The repository already contains migrations through 0027, including `apps/web/db/migrations/0025_scorecard_snapshots.sql`, `0026_outgoing_prs_closure_method.sql`, and `0027_review_jobs_billing_pending.sql`. Creating SPEC-001 as migration 0025 would collide with existing history.
- Fix direction: Update the spec to the current migration head and name the next migration accordingly. Also include Drizzle schema updates if this repo expects schema parity.

#### M-4. SHA-only review is specified but the pipeline and worker require a PR number

- Severity: MAJOR
- Category: C, M
- Spec ref: SPEC-001 § 4 Part E FR-E1; § 5.1; § 5.2
- Quoted spec text: "prNumber (or null for SHA-only)" and body shape with `{"sha": "<hex>"}`
- What's wrong: `reviewPR()` requires `prNumber: number` (`apps/web/lib/review-pipeline.ts:53-59`). The existing job worker rejects `prNumber === null` as `user_input` (`apps/web/lib/review-job-worker.ts:89-92`). Existing SHA input resolves to an open PR before enqueue; it is not true SHA-only review.
- Fix direction: State that `SHA=<hex>` must resolve to exactly one open PR head before queueing, and persist the resolved `prNumber`. If true SHA-only review is desired, it needs a new pipeline contract and ACs.

#### M-5. Async API response contract diverges from the established channel route

- Severity: MAJOR
- Category: A, G
- Spec ref: SPEC-001 § 4 Part A FR-A5; § 5.1
- Quoted spec text: "`{\"jobId\": ..., \"status\": \"queued\", \"pollUrl\": ...}`"
- What's wrong: The existing route returns `jobId`, `statusUrl`, and `expectedDurationSec`, not `pollUrl` or `status` (`apps/web/app/api/v1/installations/[id]/review/route.ts:447-453`). The existing poll route also authenticates via `X-AntFleet-Challenge-Id` and `X-AntFleet-Signature` headers (`apps/web/app/api/v1/installations/[id]/review/[jobId]/route.ts:59-74`). The spec says it reuses the established async protocol, but changes the response shape without justification.
- Fix direction: Match the existing channel route shape unless there is a deliberate versioned API reason to differ. If x402 poll auth differs, specify that as an intentional new contract.

#### M-6. Error envelopes do not match existing AntFleet API conventions

- Severity: MAJOR
- Category: B, G
- Spec ref: SPEC-001 § 4 Part C FR-C1; § 4 Part D FR-D1; § 5.1
- Quoted spec text: "`{\"error\": \"...\", \"code\": \"aeon_context_required\"}`"
- What's wrong: Existing API errors are enveloped as `{ "error": { "code": "...", "message": "..." } }` (`apps/web/lib/api-v1/responses.ts:22-38`). The flat 403/429 bodies in SPEC-001 would create a second error schema for a new public endpoint.
- Fix direction: Use the existing `jsonError()` envelope for 403 and 429, or explicitly version the x402 endpoint response schema and add compatibility rationale.

#### M-7. Receipt URL and schema assumptions conflict with the current receipts surface

- Severity: MAJOR
- Category: G, M
- Spec ref: SPEC-001 § 4 Part E FR-E2; § 10 OQ-4
- Quoted spec text: "`antfleet.dev/receipts/{review_id}` where `review_id` is a UUID"
- What's wrong: Current `/receipts/[id]` loads `finding_status.finding_id`, not `reviews.review_id` (`apps/web/db/queries.ts:1053-1080`, `apps/web/app/receipts/[id]/page.tsx:21-35`). The current public receipt page is finding-level and only for public closed findings, while SPEC-001 needs a receipt URL even for zero-finding reviews and failed/refunded jobs.
- Fix direction: Decide whether SPEC-001 creates a new review-level receipt surface or changes existing receipt routing. If it creates review-level receipts, specify the route and do not describe it as unchanged existing behavior.

#### M-8. Aeon gate token mechanism omits clock-skew and rotation rules

- Severity: MAJOR
- Category: B
- Spec ref: SPEC-001 § 4 Part C FR-C2; § 10 OQ-1
- Quoted spec text: "Tokens MUST be valid for <=5 minutes"
- What's wrong: FR-C2 defines max age and replay allowance but does not define clock-skew tolerance, future timestamps, secret IDs, overlapping old/new secrets, or how rotation avoids breaking in-flight agents. OQ-1 asks whether aeon can distribute and rotate a secret, but does not specify the server-side rotation contract.
- Fix direction: Add `kid` or versioned secret support, define accepted skew (for example reject timestamps more than N seconds in the future), and define overlapping rotation windows.

#### M-9. Cost cap requires capabilities the current pipeline does not expose

- Severity: MAJOR
- Category: E, M
- Spec ref: SPEC-001 § 4 Part D FR-D3
- Quoted spec text: "track per-job inference cost in real time" and "Kill the in-flight inference calls"
- What's wrong: `reviewPR()` estimates cost after the provider calls, using `estimateRunCost(STACK.map(...))`; it does not stream real-time spend or carry abort signals into Anthropic/OpenAI calls (`apps/web/lib/review-pipeline.ts:69-108`). FR-D3 is directionally useful, but not implementable from the current interface without broader provider changes.
- Fix direction: For v1, either replace this with existing static file/prompt caps plus post-run cost accounting, or explicitly add provider abort-signal and live metering requirements with tests.

### MINOR (3)

#### m-1. `X-Aeon-Context` name differs between spec and runner contract

- Severity: MINOR
- Category: B, H
- Spec ref: SPEC-001 § 4 Part C FR-C1; § 4 Part B FR-B3
- Quoted spec text: "`X-Aeon-Context`" and "`Aeon-Context` header value"
- What's wrong: The spec alternates between `X-Aeon-Context` and `Aeon-Context`. Header names are case-insensitive, but the missing `X-` prefix could lead to implementation drift.
- Fix direction: Use `X-Aeon-Context` consistently.

#### m-2. AC-7 references FR-A7 for channel-rail idempotency

- Severity: MINOR
- Category: I
- Spec ref: SPEC-001 § 8 AC-7
- Quoted spec text: "Skill invocation returns cached result (FR-A7 idempotency)"
- What's wrong: FR-A7 is specifically x402 idempotency by `(caller_wallet, repo, sha)`. Channel-rail caching currently comes from existing review/job idempotency, not the x402 FR.
- Fix direction: Reference the existing channel idempotency behavior or add a separate FR-E/AC mapping for channel no-regression.

#### m-3. Dependency table includes `siwe` despite v1 saying no SIWE session

- Severity: MINOR
- Category: H, M
- Spec ref: SPEC-001 § 6.1
- Quoted spec text: "`siwe` ... NOT a hard v1 dep"
- What's wrong: Including a non-v1 dependency in the backend dependency table invites accidental install or scope creep. The spec already says stateless x402 payments suffice.
- Fix direction: Move `siwe` to a v2 note or remove it from v1 dependencies.

### QUESTIONS (4)

#### Q-1. Should AC-1 require Base mainnet for staging?

- Severity: QUESTION
- Category: I
- Spec ref: SPEC-001 § 8 AC-1
- Question: AC-1 requires real Base mainnet USDC and BaseScan verification. Current x402 docs and CDP network support include Base Sepolia testnet. Should the spec require both a deterministic testnet AC and a final mainnet smoke?

#### Q-2. Are external receipt consumers tolerant of `paid_via`?

- Severity: QUESTION
- Category: G
- Spec ref: SPEC-001 § 4 Part E FR-E2
- Question: I can verify internal page code, but not Aeon/Aaron dashboard consumers. The field is optional, but any consumer doing strict JSON matching could break.

#### Q-3. Is cross-wallet cached access an intentional product behavior?

- Severity: QUESTION
- Category: E
- Spec ref: SPEC-001 § 4 Part D FR-D2; § 8 AC-6
- Question: AC-6 makes W2 receive W1's paid result for free. The rationale is anti-spam and likely acceptable, but the operator should explicitly confirm this is a feature, not a privacy/billing surprise.

#### Q-4. Are `@quicknode/x402` and `@coinbase/x402` real install targets?

- Severity: QUESTION
- Category: M
- Spec ref: SPEC-001 § 6.1; § 10 OQ-5
- Question: Official current docs show `@x402/*` packages and older v1 package names like `x402`, not the package names in the spec. I did not run npm registry lookups as validation; dependency choice should be verified before build.

## Cross-reference resolution matrix

| Source location | Reference target | Auditor verdict |
|---|---|---|
| Header | Async review API, schema head 0024 | Partial - route exists, but schema head is now beyond 0024 |
| Header | aeon-skills pack v2.0 | Resolves - public `antfleet/aeon-skills` exposes v2 channel skill |
| Header | `antfleet[bot]` GitHub App | Resolves - existing channel route uses installation tokens |
| § 3 table | New x402 route | Partial - new file does not exist yet, acceptable for spec |
| § 3 table | `apps/web/lib/x402/siwe.ts` | Broken - v1 says no SIWE session; new file is unnecessary or misnamed |
| § 3 table | x402 facilitator (OQ-5) | Partial - official facilitator exists, but current docs differ from v1 assumptions |
| § 3 table | `apps/web/lib/x402/aeon-gate.ts` | Partial - new file not present, acceptable |
| § 3 table | `apps/web/lib/x402/rate-limit.ts` | Partial - new file not present, acceptable |
| § 3 table | `apps/web/lib/github-files-public.ts` | Partial - `fetchChangedFilesWith()` can accept injected Octokit, but worker currently requires installation auth |
| § 3 table / FR-E1 | `apps/web/lib/review-pipeline.ts` | Partial - rail-agnostic, but requires numeric PR number |
| § 3 table | `apps/web/lib/review-job-worker.ts` | Partial - worker exists, but currently resolves installation id/token and cannot run install-free x402 |
| § 4 FR-A2 | Coinbase x402 v1 spec | Partial - current docs are v2-first; v1 must be pinned explicitly |
| § 4 FR-A6 | GitHub public REST API | Resolves conceptually - public Octokit/no-auth is feasible |
| § 4 FR-E3 | Migration 0025 | Broken - 0025 already exists for scorecard snapshots |
| § 5.4 | `aaronjmars/aeon/skill-packs.json` | Resolves - current entry has `skills: ["pr-review-antfleet"]` |
| § 6.1 | `viem` | Resolves - present in `apps/web/package.json` |
| § 6.1 | `@coinbase/x402` / `@quicknode/x402` | Partial - package names not confirmed in current official docs |
| § 6.3 | Coinbase x402 spec | Resolves - public docs/spec repo accessible |
| Appendix A | `apps/web/lib/paywall/invoice.ts` | Partial - local invoice is x402-shaped but includes `chainId` and omits some current v2 fields |
| Appendix A | `apps/web/app/api/v1/installations/[id]/review/route.ts` | Resolves - route exists and returns 202 async jobs |
| Appendix A | `antfleet/bankrskills-bench` | Not verified - not in this repo; no proprietary code browsed |
| Appendix A | Telegram chat | Not verifiable from available sources |

## OQ disposition

### OQ-1. Aeon-context gate token mechanism

- OQ quote: "Confirm with Aaron whether aeon runtime can distribute and rotate `AEON_GATE_SECRET` to authorized aeon agents."
- Can auditor answer from source materials? No.
- Disposition: Real operator/partner decision. However, the spec must still define clock skew and rotation mechanics before build.

### OQ-2. Per-wallet rate limit value

- OQ quote: "Decide whether to ship at 10/hour or pick a different starting value before AC-5 lands."
- Can auditor answer from source materials? No.
- Disposition: Real operator risk-tolerance decision. The rationale caps one wallet at about $5/hour and is explicit enough for v0.1.

### OQ-3. Per-repo cooldown window

- OQ quote: "Default ships; revisit on usage data."
- Can auditor answer from source materials? No.
- Disposition: Real product/economics decision. The cross-wallet cache behavior should be explicitly confirmed.

### OQ-4. Unified receipt namespace shape

- OQ quote: "Default ships unless the dashboard team needs URL-level disambiguation."
- Can auditor answer from source materials? Yes, enough to reject the current wording.
- Proposed answer: Existing `/receipts/{id}` is finding-level, not review-level. Keep existing finding receipt URLs unchanged and create a distinct review-level receipt surface if x402 needs proof for zero-finding or refunded jobs.
- Source: `apps/web/db/queries.ts:1053-1080`, `apps/web/app/receipts/[id]/page.tsx:21-35`

### OQ-5. x402 facilitator choice

- OQ quote: "Verify license + endpoint stability of Coinbase's facilitator before AC-1 lands."
- Can auditor answer from source materials? Partially.
- Proposed answer: Current Coinbase/CDP docs recommend the CDP facilitator for mainnet, but it requires CDP API keys; x402.org facilitator is testnet-only. The spec should choose CDP mainnet explicitly for production and x402.org for testnet, or keep this as an operator decision if account/API-key posture is unsettled.
- Source: https://docs.cdp.coinbase.com/x402/network-support

## AC coverage matrix

| FR | AC coverage | Verdict |
|---|---|---|
| FR-A1 endpoint shape | AC-1, AC-2 | Covered |
| FR-A2 x402 payload compliance | AC-1 | Partial - no explicit schema conformance test |
| FR-A3 stateless wallet identity | AC-1, AC-3, AC-5 | Partial - signer extraction not directly tested |
| FR-A4 USDC on Base mainnet only | AC-1 | Covered, but testnet gap is a question |
| FR-A5 async job protocol | AC-1 | Partial - response shape mismatch with existing route not tested |
| FR-A6 public-repo fetch path | AC-1 | Partial - no private repo / unauth fetch AC |
| FR-A7 idempotency | AC-3 | Covered for same wallet; cross-wallet cooldown separately in AC-6 |
| FR-A8 terminal states | AC-4 | Partial - only provider_error tested; timeout/internal/user_error/cost_cap missing |
| FR-A9 refund semantics | AC-4 | Partial - void path covered, pending_refunds fallback not covered |
| FR-A10 pricing | AC-1, AC-7 | Covered |
| FR-B1 skill folder | AC-8 | Partial - AC-8 assumes new repo HEAD but does not assert folder files |
| FR-B2 SKILL.md contract | AC-1, AC-8 | Partial |
| FR-B3 runner contract | AC-1 | Covered at happy path only |
| FR-B4 output parity | AC-1, AC-4 | Partial |
| FR-B5 registry PR | AC-8 | Covered |
| FR-C1 gate header | AC-2 | Covered |
| FR-C2 token mechanism | AC-2 | Partial - no clock skew or rotation tests |
| FR-C3 removability | No AC | Gap - MAJOR candidate if not addressed by adding an AC |
| FR-D1 per-wallet rate limit | AC-5 | Covered |
| FR-D2 per-repo cooldown | AC-6 | Covered |
| FR-D3 cost cap | No AC | Gap - MAJOR candidate if FR-D3 remains in v1 |
| FR-E1 pipeline reuse | AC-7 | Partial - no direct assertion that `reviewPR()` remains rail-agnostic |
| FR-E2 receipt schema | AC-1, AC-4, AC-7 | Partial - current receipt route conflict unresolved |
| FR-E3 schema additions | No AC | Gap - migration should have a migration test or dry-run AC |
| FR-E4 no channel regression | AC-7 | Covered |

ACs with no FR: none. ACs that map to weak or partial FR coverage: AC-1, AC-4, AC-7.

## Suggested fix order

1. Fix the CRITICAL refund contradictions: align private repo errors and terminal taxonomy with the production channel rail.
2. Choose x402 generation and package set: current v2 or explicitly pinned legacy v1. Update headers, network identifiers, facilitator endpoints, and payload fields accordingly.
3. Update migration numbering/schema contract to the current repo head and add a migration AC.
4. Resolve receipt identity: finding-level existing receipts versus new review-level x402 receipts.
5. Decide SHA-only semantics: resolve to PR before queueing or design a real SHA-only pipeline.
6. Align x402 async response and error envelope with existing API conventions.
7. Add missing ACs for FR-C3, FR-D3, FR-E3, and the full terminal-state matrix.
8. Tighten aeon-gate token mechanics: skew, secret ID, and rotation window.
9. Verify and pin dependency names/licenses after the x402 generation decision.
