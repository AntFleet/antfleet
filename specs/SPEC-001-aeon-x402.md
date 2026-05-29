# SPEC-001 — Aeon x402 pull-mode review skill

**Version:** 0.4 (2026-05-29, round-3 narrow audit closing — documentation-only)
**Depends on:** AntFleet async review API (POST `/api/v1/installations/{id}/review`, schema head 0027); aeon-skills pack v2.0; `antfleet[bot]` GitHub App at https://github.com/apps/antfleet; Coinbase CDP x402 facilitator (mainnet); x402.org reference facilitator (testnet)

**Change log v0.1:**
- Initial draft following partnership agreement with aeon (founder: aaronjmars, 2026-05-29).
- Defines the v1 scope: aeon-gated x402 endpoint, new skill variant, public-repo fetch, dual-rail backend coexisting with wallet-bound channel reviews.
- Locks the "aeon-first, expand later" sequencing per operator decision 2026-05-29.
- Defers Bankr ecosystem listing, adversarial-input hardening, and sybil scoring to a v2 decision gated on v1 performance.

**Change log v0.2:**
- C-1/C-2: Align terminal-state and refund semantics with production `review_jobs.status` + `failure_mode`; private/inaccessible repos are `user_input` and settle.
- M-1: Move x402 contract to v2 headers, payload shape, CAIP-2 network IDs, and `@x402/*` packages.
- M-2: Replace pre-terminal settlement assumptions with verify-then-defer-settle; unused authorizations expire without settlement.
- M-3: Update schema dependency and migration contract from stale 0024/0025 assumptions to current head 0027 and next migration 0028.
- M-4: Constrain SHA targets to exactly one open PR head; true SHA-only review stays out of v1 scope.
- M-5: Align async response shape with existing route fields: `jobId`, `statusUrl`, `expectedDurationSec`.
- M-6: Align x402 error responses with `jsonError()` envelope `{error:{code,message}}`.
- M-7: Add a new review-level receipt surface at `/receipts/review/{review_id}` while leaving finding receipts untouched.
  - x402 job terminal-state payloads include the review-level URL (`/receipts/review/{review_id}`) by default, not finding-level.
- M-8: Define aeon-gate token `kid`, clock-skew tolerance, and overlapping secret rotation.
- M-9: Replace live cost kill with post-run cost accounting plus hard 600-second timeout.
- m-1: Use `X-Aeon-Context` consistently.
- m-2: Clarify AC-7 uses existing channel idempotency, not x402 FR-A7.
- m-3: Remove the JWT-session library from v1 dependencies; keep it as a v2-only note.
- Q-1: Add AC-1a Base Sepolia testnet smoke before mainnet AC-1.
- Q-2: Document `paid_via` as an optional additive receipt field for strict consumers.
- Q-3: Document cross-wallet cache as intentional product behavior.
- Q-4: Gate implementation on npm registry verification and explicit version pinning for x402 packages.

**Change log v0.4:**
- Round-3 narrow audit MINOR (NEW-1) closure: v0.3 change log omitted explicit Q2-1 acknowledgement. Q2-1 had no spec change; the npm-registry verification process gate at § 6.1 is retained. No normative content changed v0.3 → v0.4; this is a documentation-completeness patch only.

**Change log v0.3:**
- C2-1: Drop the migration 0028 `failure_mode` CHECK constraint entirely; channel-rail-only values such as `insufficient_channel_balance` remain application-gated.
- C2-2: Add FR-A4b defining `ANTFLEET_X402_TREASURY`, EIP-55 validation, same-hot-wallet default, fail-closed missing-env behavior, and settle-address pinning.
- C2-3: Replace hard-coded network/asset/facilitator assumptions with `X402_NETWORK`, `X402_USDC_ASSET`, and `X402_FACILITATOR`, including Base Sepolia staging values.
- C2-4: Add FR-A4c and FR-B3 requirements for EIP-3009 windows: skill mints 600s authorizations, server rejects windows over 900s.
- C2-5: Add § 5.5 test infrastructure deliverables and wire them into § 11 build order.
- C2-6: Surface that x402 terminal payloads use review-level receipt URLs by default.
- C2-7: Enumerate the AC-7 channel-rail test gate set.
- C2-8: Rewrite § 7 to summarize round-1 and round-2 audit closures.

---

## 0. Operator-paste invocation block

```
Implement SPEC-001 (Aeon x402 pull-mode skill). The existing wallet-bound
channel review path (POST /api/v1/installations/{id}/review) is the
reference implementation for the review pipeline, idempotency, refund
semantics, and async job protocol. This spec adds an x402-compliant
sibling endpoint that accepts per-call USDC payment via the Coinbase x402
spec, gated to aeon-ecosystem callers in v1.

As you work, maintain a running
apps/web/lib/x402/implementation-notes.md that captures:

- Design decisions: choices made where the spec was ambiguous
- Deviations: places where you intentionally departed from the spec, and why
- Tradeoffs: alternatives considered and why you picked what you did
- Open questions: anything you'd want me to confirm or revise
```

---

## 1. Mission

The AntFleet GitHub App and the wallet-bound aeon-skills v2 skill cover
**install-required** review flows: a repo operator installs `antfleet[bot]`,
binds a wallet, funds a USDC channel on Base, and reviews flow on every
PR or via on-demand skill invocation. This works well for committed
operators (aeon-org, miroshark, the bench) but presents real friction
for **per-repo** adoption: a stranger spinning up a new aeon repo today
cannot review code without completing the 5-step onboarding.

The aeon ecosystem grows by spawning new repos. Repo-by-repo install
does not compose with that growth pattern. The aeon founder's pushback
on 2026-05-29 was explicit: "not sure the github app install could
really scale, especially for new aeon repos. why not just x402?"

SPEC-001 introduces a **pull-mode review path** that:

- Requires no `antfleet[bot]` install on the target repo (public repos only).
- Requires no wallet-bound installation row, no EIP-191 binding ceremony.
- Accepts payment per call via the Coinbase x402 protocol (HTTP 402 +
  USDC settlement on Base).
- Reuses the existing review pipeline (Opus 4.7 + GPT-5 consensus,
  async job model, idempotency, refund logic) byte-for-byte.
- Ships as a sibling skill (`pr-review-antfleet-x402`) in the existing
  aeon-skills v2 pack, riding the `trust_level: trusted` registry entry.

After SPEC-001 ships, the user experience for an aeon agent reviewing
a public repo is:

```
TARGET=PR=42;REPO=acme/demo
```

— one skill invocation. Funded wallet → call → review → public receipt
URL. Zero install dance.

**v1 is aeon-only.** Callers MUST prove aeon-ecosystem origin via the
gate mechanism in § 4 Part C. Bankr ecosystem listing and broader
public access are explicit v2 decisions gated on v1 performance
(real usage, clean economics, no abuse incidents).

---

## 2. Scope

### 2.1 In scope (v1)

**Part A — x402 endpoint:**
- New HTTP route at `POST /api/v1/review/x402` (sibling to existing
  `POST /api/v1/installations/{id}/review`).
- x402 v2 spec compliance: returns HTTP 402 + payment
  requirements when unauthenticated/unpaid; accepts `PAYMENT-SIGNATURE` header
  with signed USDC payment intent; settles on Base mainnet.
- Stateless x402 v2 payment-as-auth; no API key, no install row.
- Public-repo fetch path via unauthenticated GitHub REST API (no
  `antfleet[bot]` required).
- Reuses existing async job protocol: returns 202 + `jobId` immediately;
  caller polls `GET /api/v1/review/x402/{jobId}` until terminal state.
- Idempotency by `(caller_wallet, repo, sha)`: re-submission returns
  the existing job; no double-debit.
- Settlement semantics aligned with wallet-bound channel failure modes:
  settle `complete`, `user_input`, and `validation`; do not settle
  `provider_error`, `timeout`, `internal`, or `cost_cap_exceeded`.

**Part B — skill variant:**
- New skill folder in `antfleet/aeon-skills` repo: `pr-review-antfleet-x402/`
  with `SKILL.md`, `run.mjs`, `package.json`.
- Skill invocation contract identical to existing `pr-review-antfleet`:
  `TARGET=PR=<n>;REPO=<owner>/<repo>` or `TARGET=SHA=<hex>;REPO=...`.
- Skill uses an x402 v2 client (`@x402/core` + `@x402/evm` and
  HTTP adapter) to handle
  402 → sign → retry automatically; operator sees a single happy-path
  invocation.
- Output written to `.outputs/pr-review-antfleet-x402.md` with public
  receipt URL prominently linked.
- One-line PR to `aaronjmars/aeon` repo's `skill-packs.json` to add
  the new slug to the existing AntFleet entry's `skills` array.

**Part C — aeon-context gate (v1 only):**
- The x402 endpoint MUST reject callers that cannot prove aeon-ecosystem
  origin. Acceptable proof mechanism is locked in OQ-1 (default position:
  HMAC-signed `X-Aeon-Context` header bearing an aeon session identifier
  + timestamp, signed by a shared secret distributed via aeon's runtime).
- Rejected callers receive HTTP 403 with the body
  `{"error": "x402 reviews currently restricted to aeon callers; broader access planned for v2"}`.
- The gate is removable in v2 by changing one feature flag; the spec
  architecture MUST NOT introduce coupling that prevents this.

**Part D — abuse infra v1 (minimal):**
- Per-wallet rate limit: max 10 successful reviews per rolling 1 hour
  (OQ-2 confirms or revises this number).
- Per-repo cooldown: max 1 fresh review per repo per rolling 10 minutes
  (OQ-3 confirms or revises). Repeat requests within the window return
  the cached idempotent result, no debit.
- Per-call inference cost cap: any single review whose inference spend
  exceeds 3× the `REVIEW_PRICE_USDC` floor is marked
  `failure_mode='cost_cap_exceeded'` after post-run accounting and is
  not settled. Prevents adversarial-input budget burn in v1 without
  full hardening.

**Part E — dual-rail backend:**
- The review pipeline (`apps/web/lib/review-pipeline.ts`) is reused
  unchanged. x402 callers and wallet-bound-channel callers feed the
  same `reviewPR()` entry point.
- A new public review-level receipt page at
  `antfleet.dev/receipts/review/{review_id}` (existing finding-level
  receipts at `antfleet.dev/receipts/{finding_id}` untouched). See FR-E2.
- The review-jobs table (`review_jobs`, schema head 0027) gains nullable
  columns `caller_wallet text` and `payment_rail text check (payment_rail in ('channel','x402'))`.
- Existing on-PR-open auto-review flow (channel rail) is untouched. No
  observable behavior change for existing AntFleet installations.

### 2.2 Out of scope for v1

- **Bankr registry submission.** No PR to `BankrBot/skills`. The skill
  lives in `antfleet/aeon-skills` only.
- **Public access (non-aeon callers).** Removed only by an explicit v2
  decision after evaluating v1 performance.
- **Private repo support via x402.** Private repos still require the
  GitHub App path. x402 mode requires a public repo.
- **PR comment posting from x402 reviews.** Without `antfleet[bot]`
  installed on the target repo, we have no permission to post comments.
  Output is receipt-URL-only.
- **Sybil scoring, adversarial-input hardening, reputation scoring.**
  Deferred to v2. Part D abuse infra is the minimum that ships in v1.
- **Pricing differentiation between rails.** Both rails are $0.50 USDC
  per review in v1. Volume discounts on the channel rail are a future
  decision.
- **Multiple production chains or payment methods.** USDC on Base only
  for production v1; Base Sepolia appears only in AC-1a testnet smoke.
- **Programmatic refund initiation by callers.** Refunds are
  server-decided based on terminal job status, same as existing channel
  reviews.
- **True SHA-only review (review a commit without an open-PR context).**
  v1 requires SHA targets to resolve to exactly one open PR head.

### 2.3 Explicit non-goals

- SPEC-001 is NOT a Bankr-ecosystem product launch. It is the
  enabling infrastructure that makes a future Bankr launch possible
  if v2 chooses that direction.
- SPEC-001 does NOT promise public access. The aeon-gate is a v1
  feature, not a temporary scaffold.
- SPEC-001 does NOT change the GitHub App's behavior, the channel rail's
  pricing, or any existing receipt URL.

---

## 3. Integration narrative

This section describes how SPEC-001 composes with the existing AntFleet
backend, the aeon-skills v2 pack, and the aeon registry.

### End-to-end flow: aeon agent invokes x402 review on a new public repo

```
Aeon agent             aeon-skills           antfleet.dev          GitHub (public)
    │                       │                     │                      │
    │ TARGET=PR=42;         │                     │                      │
    │ REPO=acme/demo        │                     │                      │
    │──────────────────────>│                     │                      │
    │                       │                     │                      │
    │                       │ POST /api/v1/       │                      │
    │                       │   review/x402       │                      │
    │                       │ (no payment)        │                      │
    │                       │────────────────────>│                      │
    │                       │                     │                      │
    │                       │  HTTP 402           │                      │
    │                       │  + paymentReq       │                      │
    │                       │<────────────────────│                      │
    │                       │                     │                      │
    │                       │ sign USDC payment   │                      │
    │                       │ with aeon wallet    │                      │
    │                       │                     │                      │
    │                       │ POST /api/v1/       │                      │
    │                       │   review/x402       │                      │
    │                       │ + PAYMENT-SIGNATURE │                      │
    │                       │ + X-Aeon-Context    │                      │
    │                       │────────────────────>│                      │
    │                       │                     │                      │
    │                       │                     │ verify x402 payload  │
    │                       │                     │ verify aeon gate     │
    │                       │                     │ rate limit check     │
    │                       │                     │ defer settlement     │
    │                       │                     │                      │
    │                       │  202 + jobId        │                      │
    │                       │<────────────────────│                      │
    │                       │                     │                      │
    │                       │                     │ fetch PR diff        │
    │                       │                     │ (public REST API)    │
    │                       │                     │─────────────────────>│
    │                       │                     │<─────────────────────│
    │                       │                     │                      │
    │                       │                     │ run reviewPR()       │
    │                       │                     │ (Opus + GPT-5)       │
    │                       │                     │                      │
    │                       │ GET .../{jobId}     │                      │
    │                       │  (poll every 10s)   │                      │
    │                       │────────────────────>│                      │
    │                       │  complete +         │                      │
    │                       │  findings +         │                      │
    │                       │  receipt URL        │                      │
    │                       │<────────────────────│                      │
    │                       │                     │                      │
    │ .outputs/             │                     │                      │
    │ pr-review-            │                     │                      │
    │ antfleet-x402.md      │                     │                      │
    │<──────────────────────│                     │                      │
```

### How SPEC-001 composes with existing AntFleet pieces

| Step | Component | Source |
|---|---|---|
| x402 negotiation | `apps/web/app/api/v1/review/x402/route.ts` (new) | SPEC-001 § 4 Part A |
| Wallet identity | x402 v2 payment signer | SPEC-001 FR-A3 |
| USDC settlement on Base | x402 facilitator (OQ-5) | SPEC-001 FR-A4 |
| Aeon-context gate | New: `apps/web/lib/x402/aeon-gate.ts` | SPEC-001 § 4 Part C |
| Rate limiting | New: `apps/web/lib/x402/rate-limit.ts` | SPEC-001 § 4 Part D |
| Public-repo fetch | New: `apps/web/lib/github-files-public.ts` (extends existing `github-files.ts`) | SPEC-001 FR-A6 |
| Review pipeline | Existing: `apps/web/lib/review-pipeline.ts` | unchanged |
| Async job + polling | Existing: `apps/web/lib/review-job-worker.ts` | unchanged |
| Idempotency | Existing pattern, new key shape | SPEC-001 FR-A7 |
| Receipt rendering | Existing: receipts surface gains `paid_via` discriminator | SPEC-001 FR-E2 |
| Skill variant | New skill folder in `antfleet/aeon-skills` | SPEC-001 § 5 |
| Registry listing | One-line PR to `aaronjmars/aeon/skill-packs.json` | SPEC-001 FR-B5 |

---

## 4. Functional requirements

### Part A — x402 endpoint

**FR-A1. Endpoint shape.**
A new HTTP route is mounted at:

```
POST /api/v1/review/x402
GET  /api/v1/review/x402/{jobId}
```

`POST` accepts a JSON body identifying the review target. `GET` returns
the job's current state. Both are public (no install_id required) but
both gate on the aeon-context header (§ Part C).

**FR-A2. Coinbase x402 v2 compliance.**
The `POST /api/v1/review/x402` endpoint MUST conform to the Coinbase
x402 v2 protocol:

1. Initial request without `PAYMENT-SIGNATURE` header returns HTTP 402
   with body:
   ```json
   {
     "x402Version": 2,
     "accepts": [
       {
         "scheme": "exact",
         "network": "${X402_NETWORK}",
         "asset": "${X402_USDC_ASSET}",
         "maxAmountRequired": "500000",
         "payTo": "${ANTFLEET_X402_TREASURY}",
         "resource": "https://www.antfleet.dev/api/v1/review/x402",
         "description": "AntFleet two-model-consensus PR review (Opus 4.7 + GPT-5)",
         "mimeType": "application/json",
         "maxTimeoutSeconds": 600
       }
     ],
     "error": "PAYMENT-REQUIRED"
   }
   ```
   The `network`, `asset`, and `payTo` fields are produced from
   environment variables at request time per FR-A4 (network/asset) and
   FR-A4b (treasury). Production mainnet defaults are pinned in FR-A4;
   staging substitutes Sepolia values per FR-A4.
2. Subsequent request with
   `PAYMENT-SIGNATURE: <base64-encoded payment payload>` header is
   verified by the configured x402 v2 facilitator (OQ-5). On
   verification success, the endpoint proceeds with the review and
   returns HTTP 202.
3. Settlement of the USDC payment to the treasury address happens
   asynchronously (via facilitator's `settle` step) AFTER the review
   reaches a terminal state. Settlement is skipped on
   `provider_error`, `timeout`, `internal`, `cost_cap_exceeded`, and
   `expired` terminal states (FR-A9 refund parity).
4. A terminal 2xx response that performs settlement includes the
   `PAYMENT-RESPONSE` header containing the settled payment details
   (per x402 v2 spec). The initial 202 enqueue response is verify-only
   and does not settle.

**FR-A3. Stateless wallet identity.**
The `PAYMENT-SIGNATURE` payload's signer wallet is the caller's
identity. No separate login session is required for stateless x402 — the payment
itself is wallet-signed. The endpoint extracts the signer address from
the verified payment payload and uses it as `caller_wallet` for rate
limiting (Part D) and idempotency (FR-A7).

The endpoint does NOT issue or accept JWT session tokens in v1.
Streaming or long-polling flows that would benefit from sessions are
deferred (the async job + 10s poll pattern works without sessions).

**FR-A4. Network and asset configuration.**

The endpoint reads three env vars at startup to determine x402 network
and asset:

| Env var | Required | Production default | Staging (Sepolia) |
|---|---|---|---|
| `X402_NETWORK` | yes | `eip155:8453` (Base mainnet) | `eip155:84532` (Base Sepolia) |
| `X402_USDC_ASSET` | yes | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle USDC on Base mainnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle USDC on Base Sepolia) |
| `X402_FACILITATOR` | yes | `https://facilitator.cdp.coinbase.com` (CDP managed facilitator; requires `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`) | `https://facilitator.x402.org` (x402.org reference facilitator; testnet-only) |

**Invariants enforced at startup:**

1. All three env vars MUST be set. Missing = process exits with clear error.
2. The `(X402_NETWORK, X402_USDC_ASSET)` pair MUST be internally
   consistent (mainnet network + mainnet asset, OR testnet network +
   testnet asset). Cross-mixing (e.g., mainnet network + Sepolia asset)
   MUST cause startup failure with `code: 'x402_network_asset_mismatch'`.
3. The `X402_FACILITATOR` URL is reachable at startup (HEAD or GET
   probe within 5s). Unreachable = warn-only at startup; subsequent
   request-time failure surfaces as 503 per FR-A5.
4. For staging (`X402_NETWORK=eip155:84532`), `X402_FACILITATOR` MUST
   be the x402.org reference facilitator. For production
   (`X402_NETWORK=eip155:8453`), `X402_FACILITATOR` MUST be the CDP
   facilitator. This pinning prevents accidental cross-environment
   facilitator selection.

**Single-amount, single-asset constraint.** In v1, the `accepts` array
contains exactly one entry, derived from these env vars. Multi-network
or multi-asset support is a future addition.

**Backward compatibility for AC-1a.** Staging deploys configured per
the testnet column above satisfy AC-1a's `X402_FACILITATOR=x402.org`
and `X402_NETWORK=eip155:84532` setup requirements.

**FR-A4b. Treasury address handling.**

The `payTo` value in the FR-A2 402-response payload is read from the env var `ANTFLEET_X402_TREASURY` at request time.

**Format.** EIP-55 checksummed address (mixed-case). The endpoint MUST reject malformed values at startup (process exits with a clear error) or, if the env var changes at runtime, at request time with HTTP 500 and `code: 'treasury_unconfigured'`. No fallback to a hard-coded address; misconfiguration is fail-closed.

**Ownership and custody.** The address SHOULD be the same hot wallet used by the channel rail (`ANTFLEET_DEPOSIT_ADDRESS` per existing deployment) unless the operator explicitly wants separate treasuries for the two rails. Using the same wallet simplifies reconciliation and reduces operational surface. A separate dedicated x402 treasury is permitted but not required in v1.

**Settle-address pinning.** The `/settle` call's destination MUST be identical to the address advertised in the 402 response's `payTo` field. The worker MUST refuse to call `/settle` against any address that differs from the originally advertised one (defends against runtime env-var mutation between 402 negotiation and post-review settlement). Implementation: persist the advertised `payTo` in the `review_jobs` row at enqueue time; settlement reads from the row, not from the live env var.

**Missing-env behavior.** If `ANTFLEET_X402_TREASURY` is unset at request time, the endpoint MUST return HTTP 500 with body `{"error": {"code": "treasury_unconfigured", "message": "x402 treasury address not configured"}}`. No x402 negotiation is attempted; no rate-limit budget is consumed.

**Configuration verification.** Startup health check (`/api/v1/health` or equivalent) MUST verify `ANTFLEET_X402_TREASURY` is set and well-formed. The verification result is visible to operators via the existing health endpoint.

**FR-A4c. EIP-3009 authorization window enforcement.**

The defer-settle refund mechanism (FR-A9) is load-bearing on payment authorizations actually expiring before any post-terminal `/settle` call could be issued. This FR enforces the window at both ends.

**Server-side hard ceiling.** At /verify time the endpoint MUST reject any payment authorization whose window exceeds 900 seconds (`validBefore - now > 900`). Rejection returns HTTP 400 with body `{"error": {"code": "x402_authorization_window_too_long", "message": "Authorization validBefore - now exceeds 900s; skill must set validBefore = now + 600s"}}`.

**Server-side past-time rejection.** At /verify time the endpoint MUST also reject any authorization whose `validBefore <= now` (already expired) with code `x402_authorization_expired`, and any whose `validAfter > now + 30` (starts too far in the future — matches the 30s clock-skew tolerance from FR-C2) with code `x402_authorization_not_yet_valid`.

**Persisted authorization.** On /verify success, the worker persists the verified `(validAfter, validBefore, payment_payload)` to the `review_jobs` row. Post-terminal `/settle` reads from the row and MUST refuse to call `/settle` if the persisted `validBefore` has already elapsed (`now > validBefore`). This is defense-in-depth in case the worker drains slowly or the operator triggers a manual settle.

**Rationale.** The 900s ceiling provides headroom over the worker's 600s wall-clock timeout (FR-D3) so even a job that ran the full 600s plus brief settlement latency is within window. Allowing skills to mint multi-hour authorizations would make defer-settle a guarantee of expiry-in-theory rather than expiry-in-practice.

**FR-A5. Async job protocol.**
After payment verification + aeon-gate check + rate-limit check pass,
the endpoint:

1. Inserts a row into `review_jobs` with status `queued`,
   `payment_rail = 'x402'`, `caller_wallet = <signer>`,
   `target_repo = <repo>`, `target_sha = <resolved sha>`,
   `idempotency_key` per FR-A7.
2. Returns HTTP 202 with body:
   ```json
   {
     "jobId": "<uuid>",
     "statusUrl": "/api/v1/review/x402/<uuid>",
     "expectedDurationSec": <int>
   }
   ```
   `expectedDurationSec` is computed identically to the existing
   channel-rail route (`180` seconds at the time v0.2 was written).
3. The async worker (existing `review-job-worker.ts`) picks up the row
   and runs `reviewPR()`.
4. `GET /api/v1/review/x402/{jobId}` returns the row's current state,
   including findings + `receipt_url` when complete.

**FR-A6. Public-repo fetch path.**
For x402-rail jobs, the worker MUST fetch repo contents via the
unauthenticated GitHub REST API (`api.github.com`), not via the
`antfleet[bot]` installation token. This is a code path split in
`apps/web/lib/github-files.ts` (or a sibling file `github-files-public.ts`):

- Channel-rail jobs (existing): use installation token from `GITHUB_APP_*`
  env vars.
- x402-rail jobs (new): use no auth header, rate-limit aware (60
  req/hr unauthenticated; for higher capacity, configure
  `GITHUB_PUBLIC_TOKEN` as a Classic public_repo PAT — strictly read-only).

If the target repo is private or not accessible via unauthenticated
GitHub API (404, 403), the worker MUST terminate the job with status
`failed`, `failure_mode = 'user_input'`, and
`error_code = 'repo_not_accessible'`. Per FR-A8, this state settles —
the caller is charged because the review worker performed setup work
against a target it cannot serve.

**FR-A7. Idempotency.**
The idempotency key is `sha256(caller_wallet || ":" || owner || "/" || repo || ":" || resolved_pr_number || ":" || resolved_sha)`.

For `{"target": {"pr": <n>, "repo": "..."}}` input,
`resolved_pr_number` is `<n>` and `resolved_sha` is the head SHA of
that PR at enqueue time.

For `{"target": {"sha": "<hex>", "repo": "..."}}` input, the worker
MUST resolve the SHA to its corresponding open PR head:
- If exactly one open PR in the repo has `head.sha == <hex>`, set
  `resolved_pr_number` accordingly and proceed.
- If zero open PRs match, terminate as `failed`/`failure_mode='user_input'`
  with error_code `sha_not_in_open_pr`.
- If more than one open PR matches (unusual but possible for branches
  cherry-picked across PRs), terminate as `failed`/`failure_mode='user_input'`
  with error_code `sha_ambiguous`.

True SHA-only review (review a commit without a PR context) is OUT OF
SCOPE for v1; the constraint above is documented in § 2.2.

When a `POST` arrives with an idempotency key matching an existing job:

- If the existing job is `complete` or terminal `failed`: return its
  current state with HTTP 200. No `/settle` call is made for the new
  authorization since no new work is being done.
- If the existing job is `queued` or `running`: return its current state
  with HTTP 202. No `/settle` call is made for the new authorization.

**FR-A8. Terminal states and settlement decision.**

Jobs reach one of these terminal states, stored in `review_jobs.status`
plus `review_jobs.failure_mode` per the existing channel-rail schema:

| status | failure_mode | Meaning | Settle? | Caller charged? |
|---|---|---|---|---|
| `complete` | (null) | Review finished, findings (possibly 0) written | yes | yes |
| `failed` | `provider_error` | Inference provider returned an error (Anthropic/OpenAI 5xx, model overloaded) | no | no (authorization expires) |
| `failed` | `timeout` | Review exceeded 600s wall-clock | no | no |
| `failed` | `internal` | AntFleet bug (worker crash, DB error, panic) | no | no |
| `failed` | `user_input` | Bad request (PR not found, repo private, malformed input, SHA does not resolve to one open PR head) | yes | yes |
| `failed` | `validation` | Validation rejection at endpoint (bad x402 payload, gate failure that bypassed early rejection) | yes | yes |
| `failed` | `cost_cap_exceeded` | Post-run accounting: total inference spend exceeded 3× `REVIEW_PRICE_USDC` | no | no |
| `expired` | (null) | Job aged out without reaching a terminal state | no | no |

This matches the existing channel-rail behavior in
`apps/web/lib/paywall/refund.ts`. The `cost_cap_exceeded` failure_mode
is NEW in this spec and is added to both rails' refund-eligible list
(see FR-D3 for x402-rail semantics; the channel-rail equivalent is a
non-breaking addition documented in the migration 0028 commentary).

**Channel-rail-only failure_mode values.** The production channel rail
writes additional `failure_mode` values not used by the x402 rail —
notably `insufficient_channel_balance` (when a wallet-bound channel
lacks funds at billing time, written by
`apps/web/app/api/v1/installations/[id]/review/route.ts`). These
values are valid on the shared `review_jobs.failure_mode` column but
are out of scope for x402-rail terminal-state semantics (a funded
x402 caller cannot enter an insufficient-balance state because
payment is verified pre-enqueue per FR-A9 step 1). Migration 0028
deliberately does NOT add a CHECK constraint on `failure_mode`
because application-layer gating in `apps/web/lib/paywall/refund.ts`
already enforces the refund-eligible set.

Rationale for `user_input` settling (the audit's C-1 fix): a private
repo or non-existent PR is a caller mistake. The review worker still
performed setup work (PR resolution attempt, repo fetch attempt) and
the caller's input is what failed. Channel-rail charges for `user_input`
today; x402-rail matches.

**FR-A9. Refund semantics via deferred settlement.**

The x402 lifecycle in this endpoint is:

1. PRE-REVIEW (verify only). On `PAYMENT-SIGNATURE` arrival, the
   endpoint calls the facilitator's `/verify` endpoint to validate
   the signed payment authorization. On success, the endpoint persists
   the signed authorization (EIP-3009 `transferWithAuthorization`
   payload + signature) to the `review_jobs` row alongside the job.
   The endpoint does NOT call `/settle` at this stage.

2. POST-REVIEW (settle on success, expire on failure). When the job
   reaches a terminal state, the worker decides:
   - For terminal states that settle (see FR-A8 table): the worker
     calls the facilitator's `/settle` endpoint with the persisted
     authorization. Settlement transfers USDC from caller to treasury
     on Base.
   - For terminal states that do NOT settle: the worker takes NO
     action. The EIP-3009 authorization is bounded by its own
     `validAfter` / `validBefore` window and expires unused. No USDC
     ever leaves the caller's wallet. The signed authorization bounds
     are enforced per FR-B3 (skill-side) and FR-A2/FR-A4c
     (server-side); see those FRs for the contract.

3. NO `/void` CALL. The x402 v2 facilitator interface does not include
   a void operation. The "refund" is simply the absence of a `/settle`
   call before the authorization expires.

4. NO `pending_refunds` TABLE. Because settlement is always post-
   terminal, there is no window in which we charge then refund. This
   is the load-bearing reason to defer settlement.

5. INTEGRATION TEST OBLIGATION. The chosen middleware (`@x402/express`
   or equivalent) MUST be configured for `verifyOnly: true` mode (or
   the middleware bypassed entirely with explicit `/verify` and
   `/settle` calls from the route handler). Auto-settling middleware
   is INCOMPATIBLE with this design and MUST NOT be used. Verifying
   this configuration is part of AC-4.

**FR-A10. Pricing.**
Single price tier in v1: `REVIEW_PRICE_USDC = 0.5` (= 500000 base
units). Identical to the channel-rail price. Configurable via env var
`X402_REVIEW_PRICE_USDC` (default `0.5`). Changing this requires a
deploy; no runtime price negotiation in v1.

### Part B — skill variant

**FR-B1. Skill folder structure.**
A new folder `pr-review-antfleet-x402/` is added to the `antfleet/aeon-skills`
repository alongside the existing `pr-review-antfleet/`:

```
antfleet/aeon-skills/
├── pr-review-antfleet/          # existing v2 channel-rail skill
│   ├── SKILL.md
│   ├── run.mjs
│   └── package.json
├── pr-review-antfleet-x402/     # new
│   ├── SKILL.md
│   ├── run.mjs
│   └── package.json
└── skills-pack.json             # updated to declare new skill
```

**FR-B2. SKILL.md contract.**
The new `SKILL.md` follows the same frontmatter shape as `pr-review-antfleet/SKILL.md`:

```yaml
---
name: AntFleet PR review (x402)
description: Pull-mode two-model-consensus PR review via x402. Pay-per-call USDC on Base, no AntFleet installation required. Public repos only.
var: "TARGET"
tags: [dev, code-review, antfleet, base, x402, public]
---
```

The skill body documents:
- Identical `TARGET` parsing (`PR=<n>;REPO=<owner>/<repo>` or `SHA=<hex>;REPO=...`).
- Required env vars: `AEON_X402_WALLET_PRIVATE_KEY` (signing key for x402
  payments), `AEON_CONTEXT_TOKEN` (per § 4 Part C), `ANTFLEET_API_BASE`
  (optional, default `https://www.antfleet.dev`), `ANTFLEET_OUTPUT_PATH`
  (optional, default `.outputs/pr-review-antfleet-x402.md`).
- The skill DOES NOT require `ANTFLEET_INSTALLATION_ID` (key distinction
  from the v2 channel-rail skill).
- Exit codes identical to existing skill (0 success, 2 permanent failure,
  3 transient).

**FR-B3. run.mjs implementation contract.**
The skill runner:

1. Parses `TARGET` per the documented grammar; on bad input, logs
   `ANTFLEET_BAD_TARGET` and exits 2.
2. Constructs an x402 client (per OQ-5) configured with the wallet
   private key and the `X-Aeon-Context` header value.
2a. The runner MUST construct the EIP-3009 authorization with
   `validAfter = now` and `validBefore = now + 600s`. This is below the
   server-side 900s ceiling (FR-A4c) and provides a 5-minute safety
   margin above the 600s job timeout (FR-D3). Skills that mint longer
   windows MUST be rejected by the server per FR-A4c; this client-side
   setting is the primary control.
3. Submits a POST to `/api/v1/review/x402`. The x402 client handles
   the 402 → sign-payment → retry loop transparently.
4. Polls `GET /api/v1/review/x402/{jobId}` every 10 seconds, up to 10
   minutes total, until terminal state.
5. Writes the structured output to `${ANTFLEET_OUTPUT_PATH:-.outputs/pr-review-antfleet-x402.md}`.
6. If `ALERT_CHANNEL` is set and the review surfaced a finding with
   severity `critical` or `high`, fires `./notify` with a one-line
   summary and the receipt URL.

**FR-B4. Output format parity.**
The `.outputs/pr-review-antfleet-x402.md` shape matches the existing
`pr-review-antfleet.md` exactly, with one addition: the header block
includes a `**Paid via:** x402` line and the **Receipt** URL is the
canonical proof of payment + result. There is NO `**PR comment:**` line
because x402 mode cannot post PR comments (FR-D OOS in § 2.2).

**FR-B5. Registry PR.**
A one-line PR to `aaronjmars/aeon` modifies `skill-packs.json` so the
AntFleet entry's `skills` array becomes:

```json
"skills": [
  "pr-review-antfleet",
  "pr-review-antfleet-x402"
]
```

The PR also updates the corresponding row in `docs/community-skill-packs.md`
to mention "x402 variant available — public repos only, pay-per-call."

No new trust-level review is required (AntFleet entry is already
`trust_level: "trusted"`, see aeon PR #211).

### Part C — Aeon-context gate

**FR-C1. Gate header.**
Every successful `POST /api/v1/review/x402` request MUST include the
header `X-Aeon-Context: <token>`. Missing or invalid token returns
HTTP 403 with body:

```json
{
  "error": {
    "code": "aeon_context_required",
    "message": "x402 reviews currently restricted to aeon callers; broader access planned for v2"
  }
}
```

The 403 envelope follows the existing `jsonError()` helper in
`apps/web/lib/api-v1/responses.ts`. All non-402 x402 API error
responses use this envelope; 402 remains the x402 protocol payment
requirements payload from FR-A2.

The 403 response does NOT consume rate-limit budget (FR-D1).

**FR-C2. Token mechanism, validity, and rotation.**

**Token shape.** `<kid>:<aeon_session_id>:<unix_timestamp>:<hex_hmac>`

- `kid` — secret key identifier (string, alphanumeric + hyphen).
  Identifies which secret to verify against.
- `aeon_session_id` — opaque identifier scoped to one aeon agent
  session. Echoed in audit logs.
- `unix_timestamp` — seconds since epoch when the token was minted.
- `hex_hmac` — `HMAC-SHA256(secret, "{kid}:{aeon_session_id}:{unix_timestamp}")`,
  hex-encoded.

**Server-side secrets.** The server holds an array of `(kid, secret)`
pairs in `AEON_GATE_SECRETS` (JSON-encoded env var or a small DB table).
Verification iterates: for the kid in the token, look up the secret;
verify the HMAC. Missing kid = reject (treated as invalid token).

**Validity window.** Tokens are valid when:
- `now - unix_timestamp <= 300` (5-minute max age), AND
- `unix_timestamp - now <= 30` (max 30 seconds in the future, to
  tolerate small clock skew between aeon runtime and AntFleet server).

Tokens outside this window MUST be rejected with HTTP 403, code
`aeon_context_required` (same response as a missing token, to avoid
leaking validity-window info to probers).

**Replay within validity window.** Multiple successful requests with
the same token within its 5-minute window are ALLOWED. Aeon agents
legitimately retry. The endpoint's per-wallet rate limit (FR-D1)
and per-repo cooldown (FR-D2) are the abuse defenses; the gate
itself does not deduplicate tokens.

**Rotation protocol.** To rotate a secret without breaking in-flight
agents:

1. Operator generates a new `(kid, secret)` pair and adds it to
   `AEON_GATE_SECRETS` (the array now contains both old and new pairs).
2. Operator distributes the new pair to the aeon runtime out of band.
3. Aeon runtime begins minting tokens with the new kid. Old-kid tokens
   continue to verify successfully because the old pair is still in
   the server's array.
4. After 24 hours (well past the 5-minute token max-age), operator
   removes the old `(kid, secret)` pair from the server's array.
5. Any old-kid token minted after step 2 still verifies until step 4;
   any new-kid token verifies immediately from step 2.

The 24-hour grace period eliminates any window where a legitimately
minted token would be rejected due to rotation timing.

**FR-C3. Removability invariant.**
The gate MUST be implementable as a single middleware function whose
removal does not require touching the endpoint handler or the review
pipeline. The v2 decision to open x402 to non-aeon callers is then a
single env-var flip (`X402_REQUIRE_AEON_CONTEXT=false`) or one-line
middleware removal.

This is a load-bearing architecture invariant. Any implementation that
couples gate logic into the review pipeline, the skill runner, or the
receipt rendering is non-compliant and MUST be refactored.

### Part D — Abuse infra v1

**FR-D1. Per-wallet rate limit.**
A wallet address MAY submit at most 10 successful reviews per rolling
1-hour window. The 11th request within the window returns HTTP 429 with
body:

```json
{
  "error": {
    "code": "rate_limited_wallet",
    "message": "Rate limit exceeded: 10 reviews per wallet per hour"
  },
  "retry_after_seconds": <int>
}
```

The 429 response does NOT consume payment (the request is rejected
before x402 verification). "Successful" excludes 402/403/429 responses
and excludes terminal states that do not settle (`provider_error`,
`timeout`, `internal`, `cost_cap_exceeded`).

The 10/hour number is a starting position; OQ-2 captures the operator
decision to keep or revise.

**FR-D2. Per-repo cooldown.**
A given `(owner, repo, sha)` tuple MAY produce at most 1 fresh review per
rolling 10-minute window. Repeat requests within the window MUST return
the cached idempotent result (FR-A7) at no charge, regardless of caller
wallet.

This protects against multiple aeon agents discovering the same SHA and
each submitting independent reviews. The 10-minute number is captured
in OQ-3.

**Cross-wallet caching is intentional.** When wallet W1 has paid for a
review of `(repo, sha)` and wallet W2 requests the same `(repo, sha)`
within the cooldown window, W2 receives the cached result at no charge.
The rationale:

1. Multiple aeon agents may legitimately discover the same SHA (e.g., a
   shared review queue). Each paying separately for the same review
   would be both economically wasteful and would multiply abuse risk.
2. The review result is content-addressed by `(repo, sha)`. The
   identity of the wallet that paid for it is not a privacy boundary;
   the receipt URL is shareable infrastructure.
3. Anti-spam pressure: a single wallet paying once "protects" the SHA
   from re-review until the cooldown expires, capping global cost per
   SHA per window.

This is documented here because the behavior is non-obvious and a
casual reader might mistake it for a billing bug. AC-6 explicitly
tests this case.

**FR-D3. Inference cost cap (post-run + hard timeout).**

Two layered protections cap inference budget burn per job:

**Layer 1: hard wall-clock timeout.** Each x402 review job is bounded
by a 600-second wall-clock timeout (matching x402 `maxTimeoutSeconds`).
If `reviewPR()` does not return within 600s of worker pickup, the worker
terminates the job with `status='failed'`, `failure_mode='timeout'`.
Per FR-A8 this state does not settle; no USDC leaves the caller's
wallet.

**Layer 2: post-run cost accounting.** When `reviewPR()` returns, the
worker computes the total inference spend for the job using
`estimateRunCost()` (existing helper in
`apps/web/lib/review-pipeline.ts`). If the computed spend exceeds
`3 × REVIEW_PRICE_USDC` (= $1.50 at v1 pricing), the worker:

1. Transitions the job to `status='failed'`, `failure_mode='cost_cap_exceeded'`.
2. Logs a structured event with the repo, sha, caller wallet, and
   computed-cost-at-cap for offline review.
3. Per FR-A8 this state does not settle; no USDC leaves the caller's
   wallet.

**What this v1 design does NOT do** (deferred to v2):
- Live cost streaming during inference. Requires provider SDK changes
  (Anthropic + OpenAI both expose token counts in chunk metadata; the
  current `reviewPR()` does not aggregate live).
- Mid-flight abort. Requires plumbing `AbortSignal` through both
  provider clients. Not in v1.
- The result: an adversarially crafted huge diff can in v1 burn the
  full inference budget up to the wall-clock timeout before the
  post-run cap fires. AntFleet absorbs that cost (the caller is
  refunded). This is acceptable for v1 aeon-only scope; the abuse
  surface is small (aeon-gated callers, per-wallet rate limit). v2
  will add live abort before opening to wider audiences.

The 3× multiplier is heuristic and may tighten in v2 after observing
real cost distributions in production.

### Part E — Dual-rail backend

**FR-E1. Review pipeline reuse.**
`apps/web/lib/review-pipeline.ts` `reviewPR()` is called identically
from both rails. No rail-aware code is permitted in the pipeline. The
pipeline receives a `ChangedFile[]` array, `owner`, `repo`, `prNumber`
(`prNumber` is always a resolved integer per FR-A7), and the resulting
findings are independent of how the request was paid for.

**FR-E2. Receipt surfaces.**

Two distinct public receipt surfaces exist post-SPEC-001:

| URL pattern | Granularity | Existing or new | Content |
|---|---|---|---|
| `antfleet.dev/receipts/{finding_id}` | Per-finding | EXISTING (channel + x402 both use) | Single finding detail, only for public closed findings |
| `antfleet.dev/receipts/review/{review_id}` | Per-review | NEW in SPEC-001 | All findings (or zero-finding notice) for one review, plus job status, payment rail, settlement details |

The new review-level surface is required because:
- x402 callers need a single shareable URL that represents the paid
  review, regardless of finding count or failure outcome.
- Zero-finding reviews and failed/refunded reviews have no finding_id
  to receipt; without a review-level URL they have no public proof at
  all.

The review-level receipt page MUST include:
- Repo, PR (resolved), SHA
- Payment rail (`channel` or `x402`)
- Job status (`complete`, `failed`/`failure_mode`, etc.)
- Settlement status (settled / not settled / pending)
- All findings (or explicit "no findings" notice)
- Link to each per-finding receipt (existing URL) for findings that
  meet the public-disclosure criteria

The existing `/receipts/{finding_id}` page MUST be unchanged in
behavior. New page is additive.

The receipt URL returned to x402 callers in the job's terminal-state
payload is the review-level URL (`antfleet.dev/receipts/review/{review_id}`),
not a finding-level URL.

The `paid_via` field added to the receipt JSON shape is OPTIONAL and
additive. External consumers (Aeon dashboard, Aaron's tooling, any
third-party scraper) that use strict JSON schema validation should add
`paid_via` as an optional string field. AntFleet will not break-change
the receipt schema without a version bump documented here. Compatibility
verification with known consumers is operator responsibility before the
v0.3 implementation lands.

**FR-E3. review_jobs schema additions.**
The next migration (0028) adds to `review_jobs`:

- `caller_wallet text` — nullable; populated for x402 jobs (lowercase
  hex address); NULL for channel jobs (caller identity is the
  installation_id).
- `payment_rail text not null default 'channel'` — values restricted
  to `'channel' | 'x402'` via check constraint.
- `x402_pay_to text` — nullable; populated for x402 jobs with the
  advertised treasury address from FR-A4b so settlement is pinned to
  the original 402 response.
- `idempotency_key text` — already present; for x402 jobs, computed
  per FR-A7.

The migration MUST be idempotent, backfill `payment_rail = 'channel'`
for all existing rows, and deliberately MUST NOT add a CHECK constraint
on `failure_mode` (application-layer gating only; see FR-A8 commentary).

**FR-E4. No regression on channel rail.**
Existing on-PR-open auto-review flow, existing wallet-bound channel
invoice flow, existing v2 aeon-skill flow, and existing GitHub App
behavior MUST be observably unchanged. This is verified by the
existing channel-rail integration tests passing without modification
after SPEC-001 ships (AC-7).

---

## 5. Interface contracts

### 5.1 x402 endpoint contract

| Property | Value |
|---|---|
| URL | `https://www.antfleet.dev/api/v1/review/x402` |
| Method | POST (create job), GET `/{jobId}` (poll) |
| Auth | None at HTTP layer; x402 payment is the auth proof |
| Required headers | `PAYMENT-SIGNATURE`, `X-Aeon-Context`, `content-type: application/json` |
| Response header on terminal 2xx settlement | `PAYMENT-RESPONSE` (settlement details) |
| Body shape | `{"target": {"pr": <n>, "repo": "owner/name"}}` or `{"target": {"sha": "<hex>", "repo": "owner/name"}}`; SHA targets are resolved to their open PR before enqueue per FR-A7. |
| 200 (idempotent hit) | Existing job state with `status: "complete"` or other terminal state included, no settlement |
| 202 (new job) | `{"jobId": "<uuid>", "statusUrl": "...", "expectedDurationSec": <int>}` |
| 402 (payment required) | x402 v2 payment requirements payload from FR-A2 |
| 403 (aeon gate) | `{"error": {"code": "aeon_context_required", "message": "..."}}` |
| 429 (rate limited) | `{"error": {"code": "rate_limited_wallet", "message": "..."}, "retry_after_seconds": <n>}` |
| Max timeout | 600 seconds (matches `maxTimeoutSeconds` in x402 payload) |
| Env: `X402_NETWORK` | CAIP-2 string; production `eip155:8453`, staging `eip155:84532` |
| Env: `X402_USDC_ASSET` | EVM address; matched to `X402_NETWORK` |
| Env: `X402_FACILITATOR` | Facilitator base URL; CDP for mainnet, x402.org for testnet |

### 5.2 Skill invocation contract

Identical to existing `pr-review-antfleet` skill except for env vars:

| Env var | Required? | Purpose |
|---|---|---|
| `AEON_X402_WALLET_PRIVATE_KEY` | yes | Signs x402 payment intents |
| `AEON_CONTEXT_TOKEN` | yes | Value of `X-Aeon-Context` header |
| `ANTFLEET_API_BASE` | optional (default `https://www.antfleet.dev`) | API host override (testing) |
| `ANTFLEET_OUTPUT_PATH` | optional (default `.outputs/pr-review-antfleet-x402.md`) | Output file path |
| `ALERT_CHANNEL` | optional | If set + critical/high finding, fire `./notify` |

NOT required (intentional difference from v2 channel skill):
- `ANTFLEET_INSTALLATION_ID`
- `ANTFLEET_WALLET_PRIVATE_KEY` (the x402 variant uses
  `AEON_X402_WALLET_PRIVATE_KEY` to make the rail-difference obvious)

### 5.3 Migration 0028 contract

```sql
-- Migration 0028: x402-rail support for review_jobs
--
-- Adds the three columns x402 jobs need (caller_wallet, payment_rail,
-- and x402_pay_to) plus indexes for lookup/listing. Does NOT add a
-- CHECK constraint on failure_mode; the production channel rail writes
-- additional literals (e.g. 'insufficient_channel_balance') that are
-- gated at the application layer via apps/web/lib/paywall/refund.ts.
-- Adding a DB-level CHECK would couple every future failure_mode
-- addition to a schema migration, which is operationally undesirable.

ALTER TABLE review_jobs
  DROP CONSTRAINT IF EXISTS review_jobs_payment_rail_check;

ALTER TABLE review_jobs
  ADD COLUMN IF NOT EXISTS caller_wallet text,
  ADD COLUMN IF NOT EXISTS payment_rail text NOT NULL DEFAULT 'channel',
  ADD COLUMN IF NOT EXISTS x402_pay_to text;

UPDATE review_jobs SET payment_rail = 'channel' WHERE payment_rail IS NULL;

ALTER TABLE review_jobs
  ADD CONSTRAINT review_jobs_payment_rail_check
  CHECK (payment_rail IN ('channel','x402'));

CREATE INDEX IF NOT EXISTS idx_review_jobs_caller_wallet
  ON review_jobs (caller_wallet)
  WHERE caller_wallet IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_payment_rail_created
  ON review_jobs (payment_rail, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_jobs_x402_pay_to
  ON review_jobs (x402_pay_to)
  WHERE x402_pay_to IS NOT NULL;
```

Apply via the existing `apply-migration-0028.ts --apply` flow (per
project memory: migrations need manual apply, columns are `text` not
`jsonb`).

### 5.4 Registry PR contract

```diff
 {
   "repo": "AntFleet/aeon-skills",
   "name": "AntFleet aeon-skills",
-  "description": "On-demand two-model-consensus PR review (Claude Opus + GPT) with on-chain USDC payment channel on Base. Pull-mode counterpart to AntFleet's auto-review GitHub App.",
+  "description": "On-demand two-model-consensus PR review (Claude Opus + GPT) with on-chain USDC payment on Base. Channel-rail variant for installed repos; x402-rail variant for public repos with pay-per-call USDC.",
   "author": "AntFleet",
   "license": "MIT",
   "homepage": "https://www.antfleet.dev",
   "category": "dev",
   "trust_level": "trusted",
   "skills": [
-    "pr-review-antfleet"
+    "pr-review-antfleet",
+    "pr-review-antfleet-x402"
   ]
}
```

### 5.5. Test infrastructure dependencies

The acceptance criteria in § 8 depend on four test artifacts that this
spec commits AntFleet to producing as part of the v1 implementation.
Each is required for the corresponding AC to be runnable.

#### 5.5.1 Fixture repo: `antfleet/x402-fixture`

**Purpose:** Public GitHub repo target for AC-1, AC-1a, and AC-10 end-to-end runs.

**Contract:** Public repository at `https://github.com/antfleet/x402-fixture`; deliberately minimal TypeScript source tree; stable canonical PR #1 with a known small diff (~50 lines) for happy-path testing; PR #2 with the AC-10 forced-large-diff fixture (~50K lines changed, README-marked test-only); no production code; created by AntFleet org and owned by `antfleet-ops`.

**Stability:** PR #1 head SHA MUST remain stable across runs (no rebases, force-pushes, or new commits). Changes to the fixture require a spec patch + AC rev.

#### 5.5.2 Migration apply script: `apply-migration-0028.ts`

**Purpose:** AC-11 references `apply-migration-0028.ts --apply` per project convention (project memory: "migrations need manual apply via `apply-migration-XXXX.ts --apply`").

**Contract:** Located at `apps/web/db/migrations/apply-migration-0028.ts`; `--apply` performs writes while bare invocation dry-runs and prints SQL; idempotent after successful apply; reports caller_wallet, payment_rail, and x402_pay_to column presence and the absence of a `failure_mode` CHECK constraint after successful apply.

#### 5.5.3 AC-12 seed rows

**Purpose:** AC-12 needs three reviewable review_jobs rows in staging DB.

**Contract:** Seed three rows via `apps/web/db/seed/x402-receipt-test-fixtures.ts` (new file): row 1 `status=complete`, payment_rail=x402, 2 associated findings; row 2 `status=complete`, payment_rail=x402, 0 findings; row 3 `status=failed`, payment_rail=x402, `failure_mode=provider_error`, 0 findings. All three reference the AC-1 fixture repo PR #1 head SHA for consistency.

#### 5.5.4 Review-level receipt page

**Purpose:** AC-12 requires the new review-level surface (`/receipts/review/{review_id}`) per FR-E2.

**Contract:** Page implemented at `apps/web/app/receipts/review/[id]/page.tsx`; renders FR-E2 contents; public (no auth required for review-level read); existing finding-level `/receipts/{id}` page at `apps/web/app/receipts/[id]/page.tsx` is unchanged.

#### Build-order coupling

These four artifacts gate the corresponding ACs:
- 5.5.1 fixture repo → AC-1, AC-1a, AC-10
- 5.5.2 migration script → AC-11
- 5.5.3 seed rows → AC-12
- 5.5.4 receipt page → AC-12

They are added to § 11 Build steps as numbered items.

---

## 6. Dependencies

### 6.1 Backend dependencies

| Dependency | Purpose | License | Notes |
|---|---|---|---|
| `@x402/core` + `@x402/express` + `@x402/evm` | x402 v2 protocol primitives, Express middleware, EVM payment handling | Apache-2.0 (verify at install) | Current official packages per x402.org docs. Pin specific versions in `package.json`. |
| Coinbase CDP API SDK | Auth for CDP mainnet facilitator | Apache-2.0 | Requires `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` env vars. CDP-hosted facilitator chosen for mainnet (free public x402.org facilitator is testnet-only). |
| `viem` | EIP-712 / EIP-191 signature verification | MIT | Already in repo deps. |
| Existing review pipeline | `apps/web/lib/review-pipeline.ts` and downstream | n/a | Reused unchanged. |
| Anthropic + OpenAI SDKs | Inference for two-model consensus | already in repo | Reused. |

All packages listed MUST be verified to exist on the npm registry and
pinned to a specific version in `apps/web/package.json` before
implementation begins. The build prompt is gated on this verification.

`siwe` is intentionally NOT a v1 dependency; stateless x402 v2
payment-as-auth suffices. A future JWT-session revision must add it in
that revision's spec.

### 6.2 External services

| Service | Purpose | Cost | Notes |
|---|---|---|---|
| x402 facilitator endpoint | Verify + settle USDC payments on Base | CDP facilitator fee + gas (paid by treasury) | CDP mainnet facilitator for production; x402.org reference facilitator for Base Sepolia tests. |
| Base RPC | Submit settlement transactions | Existing RPC budget | Reuse current Base RPC config. |
| GitHub public REST API | Fetch public-repo diffs | Free (60 req/hr unauthenticated, 5000 req/hr with PAT) | Configure `GITHUB_PUBLIC_TOKEN` (Classic public_repo PAT) for headroom. |

### 6.3 Clean-room hygiene

No proprietary AntFleet partner code is consulted for this spec. The
Bankr skills bench at `antfleet/bankrskills-bench` is a public fork
and was read for x402-pattern reference (Quicknode, Alchemy, BlueAgent
skills). No code is copied verbatim; the SPEC describes our own
endpoint, gated to our own product surface.

The x402 v2 documentation (https://docs.x402.org) is public and
normative. Reading the spec is required.

---

## 7. Audit findings encoded in this spec

This section tracks audit findings from prior revisions that are
now encoded in normative requirements above. Per the macprovider
spec discipline this spec was patterned after, findings are not
just fixed — their resolutions are documented here so future
readers understand why specific clauses exist.

**Round-1 audit (v0.1, Codex GPT-5, 2026-05-28):** 2 CRITICAL +
9 MAJOR + 3 MINOR + 4 QUESTION. All 18 findings addressed in v0.2.
Notable resolutions: terminal-state taxonomy aligned with
`apps/web/lib/paywall/refund.ts` (FR-A8); x402 v2 protocol adopted
end-to-end (FR-A2); verify-then-defer-settle replaces fictional
`/void` (FR-A9); review-level receipt surface carved out
separately from finding-level (FR-E2); aeon-gate gained `kid` +
clock skew + 24h rotation (FR-C2).

**Round-2 audit (v0.2, Claude Opus 4.7, 2026-05-29):** 1 CRITICAL
+ 4 MAJOR + 3 MINOR + 1 QUESTION. All 9 findings addressed in v0.3.
Notable resolutions: migration 0028 CHECK constraint dropped to
avoid channel-rail regression (FR-A8 commentary); treasury env var
contract fully defined (FR-A4b); testnet/mainnet routing env vars
added (FR-A4); EIP-3009 authorization window enforced server-side
(FR-A4c); test infrastructure deliverables committed (§ 5.5).

Audit reports preserved at `specs/SPEC-001-audit.md` (round-1) and
`specs/SPEC-001-v0-2-audit.md` (round-2).

---

## 8. Acceptance criteria

**AC-1 (including AC-1a), AC-2 through AC-12 must ALL pass for SPEC-001 v0.3 to be considered
build-complete.**

---

**AC-1a. End-to-end x402 review on Base Sepolia (testnet smoke).**

**Setup:** A test wallet funded with ≥ 1 USDC on Base Sepolia (via
faucet at https://faucet.circle.com or equivalent). A valid
`AEON_CONTEXT_TOKEN`. A public repo with at least one open PR. The
AntFleet staging environment configured with `X402_FACILITATOR=x402.org`
(testnet) and `X402_NETWORK=eip155:84532` (Base Sepolia).

**Action:** From a fresh aeon-skills installation:

```bash
cd skills/pr-review-antfleet-x402
ANTFLEET_API_BASE=https://staging.antfleet.dev \
TARGET="PR=1;REPO=antfleet/x402-fixture" node run.mjs
```

**Expected:**
1. The x402 client receives 402, signs the testnet USDC payment, retries, receives 202 + jobId.
2. The skill polls; job reaches `complete` within 5 minutes.
3. Testnet wallet balance decreases by exactly 0.5 USDC.
4. Output file written; review-level receipt URL renders publicly with `paid_via: x402`.

**How to verify:** Automated CI job runs this against a known fixture
PR on Sepolia every deploy. No mainnet USDC consumed.

---

**AC-1. End-to-end x402 review on a public aeon repo (mainnet smoke).**

AC-1 is the production-equivalent mainnet equivalent of AC-1a. AC-1a
is gating for every CI build; AC-1 is run manually before each
production release.

**Setup:** A funded test wallet (≥ 5 USDC on Base mainnet) and a valid
`AEON_CONTEXT_TOKEN` generated against staging `AEON_GATE_SECRETS`.
A public repo with at least one open PR (use a fixture repo in the
AntFleet org).

**Action:** From a fresh aeon-skills installation with no AntFleet
`ANTFLEET_INSTALLATION_ID` set:

```bash
cd skills/pr-review-antfleet-x402
TARGET="PR=1;REPO=antfleet/x402-fixture" node run.mjs
```

**Expected:**
1. The x402 client receives a 402, signs the USDC payment, retries, receives 202 + jobId.
2. The skill polls the job; within 5 minutes the job reaches `complete`.
3. The wallet balance decreases by exactly 0.5 USDC.
4. `.outputs/pr-review-antfleet-x402.md` is written with the findings and a review-level receipt URL.
5. The receipt URL renders publicly with `paid_via: x402` displayed.

**How to verify:** Manual end-to-end run on staging environment with
real Base mainnet transactions. Verify on-chain via BaseScan.

---

**AC-2. Aeon-gate rejection of non-aeon caller.**

**Setup:** A funded test wallet, NO `X-Aeon-Context` header (or an
invalid one — expired timestamp, wrong HMAC).

**Action:** `curl -X POST https://www.antfleet.dev/api/v1/review/x402 -H 'content-type: application/json' -d '{"target":{"pr":1,"repo":"antfleet/x402-fixture"}}'`

**Expected:**
1. HTTP 403 with body `{"error":{"code":"aeon_context_required","message":"x402 reviews currently restricted to aeon callers; broader access planned for v2"}}`.
2. No payment is consumed (wallet balance unchanged).
3. No row is inserted into `review_jobs`.
4. No rate-limit budget is consumed (a subsequent valid call still has full quota).

**How to verify:** `apps/web/app/api/v1/review/x402/aeon-gate.test.ts`
(new), plus manual curl probe against staging.

---

**AC-3. Idempotency — no double-debit on repeat submission.**

**Setup:** Successfully complete an x402 review of `acme/demo@SHA=abc123`
with wallet W. Note the receipt URL and wallet balance afterward.

**Action:** From the same wallet W, submit a fresh POST for the same
`(repo, sha)` with a new x402 payment intent.

**Expected:**
1. Endpoint detects the idempotent collision and returns HTTP 200 with
   the existing job's state (status `complete`, findings, receipt URL
   unchanged).
2. No `/settle` call is made for the new x402 authorization — wallet
   balance does NOT decrease.
3. The receipt URL is unchanged.

**How to verify:** `apps/web/app/api/v1/review/x402/idempotency.test.ts`
(new), with a mocked facilitator and recorded wallet-balance assertions.

---

**AC-4. Refund on provider_error.**

**Setup:** A configured staging path that forces the Anthropic API call
to return a 503 (e.g., a route that swaps the Anthropic client for a
fault-injecting double).

**Action:** Submit a valid x402 review request. The worker calls
inference, hits 503, exhausts retries.

**Expected:**
1. Job reaches `status='failed'`, `failure_mode='provider_error'`.
2. No `/settle` call is made. Wallet balance is unchanged because the
   authorization expires unused.
3. `.outputs/pr-review-antfleet-x402.md` is written with status
   "errored" and a clear error code.
4. The review-level receipt URL renders with `status: failed`,
   `failure_mode: provider_error`, and `settlement: not_settled`.
5. Authorization persistence: the `review_jobs` row for the failed
   job contains the persisted `validBefore` value; `validBefore - completed_at < 900s`
   demonstrating the window was within ceiling. The persisted
   authorization is not referenced again post-terminal (no `/settle`
   call ever issued for this row).

**How to verify:** Integration test against staging with fault
injection. `apps/web/lib/x402/refund.test.ts` (new) verifies deferred
settlement and unused authorization expiry.

---

**AC-5. Rate-limit enforcement.**

**Setup:** A wallet that has already completed 10 successful x402
reviews within the past 60 minutes (use a test helper to seed
`review_jobs` rows directly).

**Action:** Submit an 11th x402 review request.

**Expected:**
1. Endpoint returns HTTP 429 with body containing `code: rate_limited_wallet`
   and a `retry_after_seconds` integer corresponding to the time
   remaining until the oldest of the 10 ages out of the window.
2. No payment is consumed.
3. No row is inserted into `review_jobs`.

**How to verify:** `apps/web/lib/x402/rate-limit.test.ts` (new) plus
manual probe.

---

**AC-6. Per-repo cooldown returns cached result.**

**Setup:** Wallet W1 completes a fresh x402 review of `acme/demo@SHA=abc123`
at time T. The job reaches `complete`. The receipt URL is R1.

**Action:** Wallet W2 (different from W1) submits a fresh x402 review
of `acme/demo@SHA=abc123` at time T+5 minutes.

**Expected:**
1. Endpoint detects the per-repo cooldown and returns HTTP 200 with the
   cached job's state. Receipt URL is R1.
2. No `/settle` call is made for W2's x402 authorization.
3. No second review is triggered.

**How to verify:** Integration test with two staging wallets. The
cached-cross-wallet behavior is intentional and worth a dedicated test.

---

**AC-7. No regression on channel rail.**

**Setup:** A fresh `antfleet[bot]` install on a test repo, bound to a
funded wallet-channel installation. PRs open on the repo as normal.

**Action:** Open a new PR on the test repo (auto-review flow). Also
invoke the existing v2 channel-rail skill (`pr-review-antfleet`) on
the same PR.

**Expected:**
1. Auto-review fires within seconds of PR open; finding posted as PR
   comment; channel debited by 0.5 USDC; receipt URL rendered.
2. Skill invocation returns the cached channel-rail result via the
   existing channel idempotency mechanism (see
   `apps/web/app/api/v1/installations/[id]/review/route.ts` and
   `apps/web/lib/review-job-queries.ts`), no second debit. This is not
   FR-A7 (which scopes x402 idempotency only).
3. No observable behavior change vs. behavior measured before SPEC-001
   shipped — same comment shape, same receipt schema (with new
   optional `paid_via` field defaulting to `"channel"`).

**How to verify:** All existing channel-rail tests pass without
modification. The gate set is `apps/web/**/*.test.ts` excluding any new
`apps/web/lib/x402/**` and `apps/web/app/api/v1/review/x402/**` paths.
Specifically: `apps/web/app/api/v1/installations/[id]/review/route.test.ts`,
`apps/web/app/api/v1/installations/[id]/review/[jobId]/route.test.ts`,
`apps/web/lib/review-worker.test.ts`, `apps/web/lib/paywall/*.test.ts`,
plus any other channel-rail tests present at v0.3 spec lock. Manual
end-to-end on staging.

---

**AC-8. Registry listing updated.**

**Setup:** SPEC-001 v0.3 implementation complete. New skill exists at
`antfleet/aeon-skills` repo HEAD. Locally verified to install and run
against staging endpoint.

**Action:** Open a one-line PR to `aaronjmars/aeon` modifying
`skill-packs.json` and `docs/community-skill-packs.md` per FR-B5.

**Expected:**
1. PR diff matches the contract in § 5.4 (only `skills` array and
   description string change).
2. After merge: `./add-skill antfleet/aeon-skills pr-review-antfleet-x402`
   succeeds in a fresh aeon project.
3. The new skill appears in `aeon --list` output.

**How to verify:** Manual install + invoke in a fresh aeon project
against staging. Confirm before-merge with Aaron.

---

**AC-9. Aeon-gate removability — feature-flag flip.**

**Setup:** Staging deploy of SPEC-001 implementation. Confirm AC-2
passes (non-aeon callers rejected). Set env var
`X402_REQUIRE_AEON_CONTEXT=false` and redeploy.

**Action:** Submit a valid x402 review request WITHOUT the
`X-Aeon-Context` header.

**Expected:**
1. Request is NOT rejected by the aeon-gate middleware.
2. Request proceeds through x402 verification, rate-limit check, and
   review pipeline.
3. Behavior is identical to a gated request other than the gate check.

**How to verify:** Integration test `apps/web/lib/x402/aeon-gate.test.ts`
toggles the flag and asserts both branches. Manual staging probe with
the flag flipped.

This AC enforces FR-C3 — gate removability MUST be a single env var
flip, not a code change.

---

**AC-10. Cost-cap post-run accounting.**

**Setup:** Configure the staging review pipeline with a forced-large
diff fixture (a PR with ~50K lines changed, intentionally constructed
to exceed inference budget). Real Anthropic + OpenAI keys.

**Action:** Submit an x402 review request for the fixture PR.

**Expected:**
1. Job runs to completion of inference (or to wall-clock timeout if it
   hits 600s first).
2. Post-run cost accounting detects total inference spend > $1.50.
3. Job transitions to `status='failed'`, `failure_mode='cost_cap_exceeded'`.
4. x402 payment is NOT settled. Caller's wallet balance unchanged.
5. Receipt URL renders with `status: failed`, `failure_mode: cost_cap_exceeded`.

**How to verify:** Integration test against staging with the fixture PR.

---

**AC-11. Migration 0028 apply + backfill.**

**Setup:** A fresh database snapshot at schema head 0027.

**Action:** Run `apply-migration-0028.ts --apply` (per project
convention).

**Expected:**
1. `review_jobs` table gains `caller_wallet text` (nullable),
   `x402_pay_to text` (nullable), and
   `payment_rail text not null default 'channel' check (payment_rail in ('channel','x402'))`.
2. All existing rows have `payment_rail = 'channel'` after backfill.
3. Indexes `idx_review_jobs_caller_wallet` and
   `idx_review_jobs_payment_rail_created` and
   `idx_review_jobs_x402_pay_to` exist.
4. `failure_mode` column remains a `text` column with no CHECK
   constraint (application-layer gating only, per FR-A8 commentary).
   Verify no failure-mode CHECK constraint exists post-migration.
5. Re-running the migration is idempotent (no errors, no duplicate
   index creation).

**How to verify:** Migration test in `apps/web/db/migrations/0028.test.ts`
(new). Snapshot diff before/after via `pg_dump --schema-only`.

---

**AC-12. Review-level receipt page rendering.**

**Setup:** Three review_jobs rows in staging:
- One `complete` with 2 findings (x402-rail).
- One `complete` with 0 findings (x402-rail).
- One `failed` with `failure_mode='provider_error'` (x402-rail).

**Action:** Open each review-level receipt URL
(`antfleet.dev/receipts/review/{review_id}`) in a browser.

**Expected:**
1. All three pages render publicly without auth.
2. Each shows repo, resolved PR, SHA, payment rail (`x402`),
   job status, settlement status.
3. The 2-finding page lists both findings with links to existing
   finding-level receipts.
4. The 0-finding page shows "No findings — clean review."
5. The failed page shows the failure_mode and "Payment not settled"
   message.
6. The existing finding-level receipt page (`/receipts/{finding_id}`)
   is unchanged in behavior — confirm via spot check that a known
   finding URL still renders identically.

**How to verify:** Integration test `apps/web/app/receipts/review/[id]/page.test.tsx`
(new) + manual browser check.

---

## 9. Audit categories for SPEC-001+ revisions

**Category A: x402 protocol compliance.**
Verify the 402 response payload conforms to x402 v2 spec
exactly. Field names, types, encoding (especially the `accepts` array
shape) must match. Reference: https://docs.x402.org. Deviations
that work with one facilitator but break others are MAJOR.

**Category B: Aeon-gate removability.**
Verify the gate is implementable as a single middleware. Any
implementation that couples gate logic into the review pipeline,
skill runner, or receipt rendering is a MAJOR finding. The v2
flip-the-flag invariant (FR-C3) is load-bearing.

**Category C: Dual-rail isolation.**
Verify channel-rail and x402-rail code paths share the review
pipeline cleanly. Any rail-aware branching inside `reviewPR()` or
downstream review primitives is a MAJOR finding (FR-E1 violation).

**Category D: Refund/settlement parity.**
Verify the terminal-state → settlement decision table (FR-A8, FR-A9)
is implemented identically for both rails where the rails overlap
(specifically: `provider_error`, `timeout`, `internal` always
refund; `user_input` does not). Differences in refund behavior between
rails are CRITICAL.

**Category E: Abuse-infra adequacy for v1.**
Verify the v1 abuse infra (FR-D1–D3) is sufficient to defend against
the listed v1 threat model (single-actor griefing, accidental
self-DOS, single-wallet budget burn). Ambitions beyond v1 (sybil
resistance, adversarial-input hardening) are explicitly OUT and
should NOT be retrofitted into SPEC-001. MAJOR if the spec creeps
toward v2 scope.

**Category F: Backward compatibility for channel-rail callers.**
Every existing channel-rail behavior (auto-on-PR review, on-demand
skill, invoice flow, receipt rendering, dashboard) MUST be observably
unchanged. Any spec text implying a channel-rail behavioral change is
CRITICAL.

**Category G: Implementability.**
Could a competent backend developer build the x402 endpoint from
§ 4 Part A + § 5.1 with ≤3 clarifications? Could a skill developer
build the runner from § 4 Part B + § 5.2 with ≤3 clarifications? If
not, the spec has gaps.

**Category H: Open question discipline.**
For each OQ, can the auditor answer it from public sources (Coinbase
x402 docs, Bankr skills bench, AntFleet existing code)? If yes, the
OQ is artificial and should be MAJOR finding "OQ-X is decidable from
sources."

**Category I: Acceptance criteria coverage.**
Each AC measurable with concrete commands/test names. Each AC tests
exactly one capability. Pass rule explicit. Cross-rail interactions
(AC-7) covered.

**Category J: Scope discipline.**
Anything that belongs in a future v2 (Bankr listing, sybil scoring,
adversarial-input hardening, private repo support) MUST NOT sneak in.
MAJOR if found.

---

## 10. Open questions

**OQ-1. Aeon-context gate token mechanism.**
The v1 default is HMAC-SHA256 over
`<kid>:<aeon_session_id>:<unix_timestamp>` with shared secrets listed
in `AEON_GATE_SECRETS`. Alternatives considered:

- Signed JWT from an aeon-issued key (more standard but requires aeon
  to operate a key infrastructure or expose a JWKS endpoint).
- Per-call EIP-191 signature from an aeon-attested wallet (more
  decentralized but couples gate to wallet identity, which conflicts
  with rate-limit-per-wallet).
- Allowlist of caller wallet addresses (operationally heavy; doesn't
  compose with aeon's "spawn agents dynamically" model).

**Current position:** HMAC with `kid`, 30-second future-skew tolerance,
5-minute max age, and 24-hour overlapping secret rotation is the
lightest mechanism that gets us a v1 gate. Aaron's confirmation that
the aeon runtime can hold and rotate shared secrets would lock this. If
aeon prefers a key-pair model, we accept the extra wiring cost.

**Operator action:** Confirm with Aaron whether aeon runtime can
distribute and rotate `AEON_GATE_SECRETS` to authorized aeon agents.
If yes, HMAC ships. If no, fall back to JWT and document the trust
chain.

---

**OQ-2. Per-wallet rate limit value.**
v1 proposes 10 successful reviews per wallet per rolling hour. Rationale:
matches typical agent-loop cadence (one review every ~6 min sustained
is plausible; bursts are absorbed by the rolling window); high enough to
not annoy legitimate use; low enough to cap single-wallet budget burn
at ~$5/hour.

**Current position:** Ship 10/hour, instrument the metric, revisit in
2 weeks against actual usage data. If the 95th-percentile wallet hits
the limit, raise it; if abusers cluster at it, tighten.

**Operator action:** Decide whether to ship at 10/hour or pick a
different starting value before AC-5 lands.

---

**OQ-3. Per-repo cooldown window.**
v1 proposes 10 minutes. Rationale: an agent reviewing a SHA gets a
cached result for 10 minutes; new commits to the same PR (different SHA)
trigger a fresh review immediately; multiple agents discovering the
same SHA share one review.

**Current position:** 10 minutes ships unless an alternative is
proposed before AC-6 lands. The window can shorten (faster fresh
reviews) or lengthen (more aggressive caching) without spec changes —
it's a runtime parameter.

**Operator action:** Default ships; revisit on usage data.

---

**OQ-4 (CLOSED in v0.2). Unified receipt namespace shape.**
Current `/receipts/{id}` routes through `finding_id`, not `review_id`
(verified at `apps/web/db/queries.ts:1053` and
`apps/web/app/receipts/[id]/page.tsx:21`). SPEC-001 v0.2 creates a
distinct review-level surface at `/receipts/review/{review_id}`;
finding-level surface untouched.

---

**OQ-5. x402 facilitator choice.**
Two credible facilitator paths exist:

| Option | Pros | Cons |
|---|---|---|
| CDP mainnet facilitator | Official Coinbase-hosted mainnet path; supports x402 v2, Base `eip155:8453`, and USDC | Requires `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`; pricing and quota are external |
| Self-hosted facilitator | Full control, no external dependency | Operational cost; not justified for v1 volume |

**Current position:** CDP mainnet facilitator with explicit
`verifyOnly` configuration (defer settlement to post-terminal). x402.org
testnet facilitator for AC-1a.

**Operator action:** Verify license, quota, and endpoint stability of
Coinbase CDP facilitator before AC-1 lands.

---

## 11. Build steps

SPEC-001 v0.3 implementation is a single coordinated build (no
multi-spec choreography needed since this is the first AntFleet spec).
The implementation prompt is authored separately as
`specs/BUILD_SPEC_001_IMPL_PROMPT.md` after the audit cycle closes.

Suggested implementation order:

1. **Migration 0028** — add `caller_wallet`, `payment_rail`, and
   `x402_pay_to` columns (FR-E3). Trivial, must ship first so x402
   jobs have a place to land.
1a. **Build-prereq: create the fixture repo + seed rows.** Per § 5.5,
   create `antfleet/x402-fixture` (public, PR #1 happy path, PR #2 large
   diff). Write the seed-rows script at
   `apps/web/db/seed/x402-receipt-test-fixtures.ts`. These deliverables
   can be done in parallel with step 1 (migration).
2. **x402 endpoint** — `POST /api/v1/review/x402` + `GET /{jobId}`
   (FR-A1–A8). Wire facilitator (OQ-5), implement aeon-gate middleware
   (FR-C1–C3), rate limits (FR-D1–D3), public-repo fetch (FR-A6).
3. **Skill variant** — new folder in `antfleet/aeon-skills` repo
   (FR-B1–B4). Smoke-test against staging endpoint.
4. **Review-level receipts** — add `/receipts/review/{review_id}` and
   optional `paid_via` field (FR-E2).
5. **Integration tests** — AC-1a, AC-1, and AC-2 through AC-12.
6. **Registry PR** — one-line update to `aaronjmars/aeon` (FR-B5, AC-8).
7. **Build-postreq: AC infrastructure.** Verify all § 5.5 artifacts
   are in place. AC-1, AC-1a, AC-10, AC-11, AC-12 each gate on a § 5.5
   artifact; build is not complete until all run green.

Total estimated effort: 7–10 days for one experienced backend developer.

---

## Appendix A — References

| Source | What was taken |
|---|---|
| `apps/web/lib/review-pipeline.ts` | Existing review pipeline shape; reused unchanged per FR-E1 |
| `apps/web/lib/paywall/invoice.ts` | Existing GitHub-comment invoice shape used only as local context, not normative for x402 v2 |
| `apps/web/app/api/v1/installations/[id]/review/route.ts` | Async job protocol, idempotency, refund semantics (reference impl) |
| `antfleet/aeon-skills` v2.0 | Skill folder structure, `SKILL.md` frontmatter, `run.mjs` patterns |
| `aaronjmars/aeon` skill-packs.json | Registry entry shape, trust-level model |
| `antfleet/bankrskills-bench` (Quicknode, Alchemy x402 references) | Public x402 protocol patterns; no code copied |
| x402 v2 docs (https://docs.x402.org) | Normative protocol reference |
| Project memory `feedback_classifier_prod_actions_need_text_auth.md` | Reminder: production DB writes need explicit "i authorize" text |
| Project memory `bench_cost_commit_vs_head.md` | Inference-cost-cap rationale (Part D-3 threshold) |
| Telegram chat with @aaronjmars (2026-05-29) | Partnership context, scope decisions, "aeon-first sequencing" lock |

**Clean-room note.** No proprietary AntFleet partner code is consulted
during spec authoring. Bankr skills bench is a public fork and is
referenced only at the protocol-pattern level. x402 v2 documentation is
public and normative.
