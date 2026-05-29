# Fix prompt — SPEC-001 round-1 audit findings → v0.2

Operator-paste prompt to apply the round-1 audit findings from
`specs/SPEC-001-audit.md` (Codex CLI / GPT-5, 2026-05-28T23:25:44Z).

The round-1 audit returned verdict **NEEDS REVISION** with:

  2 CRITICAL — refund-semantic contradiction, terminal-taxonomy mismatch
  9 MAJOR    — x402 v1 vs v2, void semantics, migration head, SHA-only,
               response shape, error envelope, receipt model, gate
               mechanics, cost-cap implementability
  3 MINOR    — header naming, AC reference, dependency hygiene
  4 QUESTIONS — testnet AC, consumer tolerance, cross-wallet cache,
               package names

The operator has decided defaults for every gating question; they are
baked into the fixes below. The receiving agent applies each fix as
written, bumps the spec to v0.2, and runs the **full audit prompt
again** (not narrow regression) because round-1 had CRITICALs.

Version bumps:
  SPEC-001 v0.1 → v0.2

Run in **Claude Code**. Expected duration: ~90–120 min (substantial
patch — terminal-state taxonomy rewrite, x402 v1→v2 protocol bump,
new review-level receipt surface, gate rotation mechanics, response
shape alignment).

Paste everything between `=== BEGIN PROMPT ===` and `=== END PROMPT ===`
into a fresh Claude Code session rooted at `/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are applying round-1 audit fixes to SPEC-001 (Aeon x402 pull-mode
review skill). The audit report at specs/SPEC-001-audit.md returned
verdict NEEDS REVISION with 2 CRITICAL + 9 MAJOR + 3 MINOR + 4 QUESTION
findings.

You will edit one file in place and bump its version:
  /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md  v0.1 → v0.2

You will NOT modify any production source code, migrations, or other
spec documents. This is a spec-only patch.

## Critical constraints

**1. Dual-rail isolation invariant.** The existing channel-rail review
path is in production. Do NOT introduce any clause that changes
observable channel-rail behavior. The pipeline reuse invariant
(reviewPR() called identically from both rails, no rail-aware code in
the pipeline) MUST be preserved.

**2. Aeon-gate removability invariant.** Gate must remain a single
middleware whose removal does not require touching the endpoint
handler, the review pipeline, the worker, or the receipt rendering.
Rotation mechanics are added in this fix pass but the architectural
invariant is preserved.

**3. v1 scope discipline.** The § 2.2 out-of-scope list is unchanged.
Do NOT retrofit Bankr listing, sybil scoring, adversarial-input
hardening, private-repo-via-x402, or PR-comment-posting-in-x402-mode
into v0.2. If a fix tempts you toward any of these, stop and re-read
§ 2.2.

**4. Surgical scope per fix.** Each fix below is fully specified.
Apply exactly what's described — no additional "improvements". Drift
beyond the specified scope is itself a scope-creep failure mode that
would require another audit round.

**5. Source code is authoritative.** When a fix references "existing
behavior" (refund.ts, route.ts, etc.), read those files first and
mirror their actual semantics. Do NOT spec a behavior that differs
from production and call it "alignment."

## Required reading (in order)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-audit.md
   — read fully. The audit's "Suggested fix order" is the basis for
   this patch; the order below reorganizes by spec section for
   editing efficiency, but every audit finding is addressed.

2. /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md (v0.1)
   — the spec being edited. Read fully so you know what's there
   before you start changing it.

3. /Users/augstar/projects/antfleet/apps/web/lib/paywall/refund.ts
   — AUTHORITATIVE source for terminal-state taxonomy. Read carefully:
   note the actual `failure_mode` enum values, which are refund-eligible
   vs non-refund-eligible. SPEC-001's invented `user_error`/`provider_error`/
   `internal_error`/`timeout` taxonomy must be replaced with this.

4. /Users/augstar/projects/antfleet/apps/web/lib/api-v1/responses.ts
   — AUTHORITATIVE source for error envelope shape. Note the
   `jsonError()` helper and the `{error: {code, message}}` envelope.
   SPEC-001's flat `{error, code}` shape must be replaced.

5. /Users/augstar/projects/antfleet/apps/web/app/api/v1/installations/[id]/review/route.ts
   /Users/augstar/projects/antfleet/apps/web/app/api/v1/installations/[id]/review/[jobId]/route.ts
   — AUTHORITATIVE source for async API response shape. Note the
   returned fields (`jobId`, `statusUrl`, `expectedDurationSec`).
   SPEC-001's `pollUrl`/`status` shape must be replaced.

6. /Users/augstar/projects/antfleet/apps/web/lib/review-pipeline.ts
   /Users/augstar/projects/antfleet/apps/web/lib/review-job-worker.ts
   — confirm `prNumber: number` is required (no SHA-only path exists).
   This justifies fix M-4's constraint.

7. /Users/augstar/projects/antfleet/apps/web/db/queries.ts (around line 1053)
   /Users/augstar/projects/antfleet/apps/web/app/receipts/[id]/page.tsx
   — confirm /receipts/{id} routes through finding_id, not review_id.
   This justifies the new review-level receipt surface in fix M-7.

8. /Users/augstar/projects/antfleet/apps/web/db/migrations/
   — list contents. Confirm 0027 is the current head. Migration in
   this fix becomes 0028.

9. https://docs.x402.org/core-concepts/http-402 (web-fetch)
   https://docs.x402.org/guides/migration-v1-to-v2 (web-fetch)
   https://docs.cdp.coinbase.com/x402/network-support (web-fetch)
   — AUTHORITATIVE sources for x402 v2 protocol. Confirm header names
   (PAYMENT-REQUIRED, PAYMENT-SIGNATURE, PAYMENT-RESPONSE), payload
   shape (x402Version: 2, CAIP-2 network IDs), and current package
   names (@x402/core, @x402/express, @x402/evm).

## Operator decisions baked in as defaults

The audit surfaced 8 operator-gating questions. Defaults below are
already chosen; the spec-writer applies them. If during application
a default appears impossible to honor (e.g. an x402 v2 package is
genuinely unpublished), STOP, document the blocker in the handback
summary, and let the operator decide. Do NOT pick a different default
silently.

| # | Decision | Default | Where it lands |
|---|---|---|---|
| 1 | x402 generation | **v2** (current official spec) | Fix M-1 |
| 2 | Refund mechanism | **Verify-then-defer-settle** (no /void, no pending_refunds queue) | Fix M-2 |
| 3 | Receipt model | **New review-level surface at `/receipts/review/{review_id}`** (existing finding-level surface untouched) | Fix M-7 |
| 4 | SHA-only semantics | **SHA must resolve to exactly one open PR head; reject as `user_input` otherwise** (no real SHA-only pipeline in v1) | Fix M-4 |
| 5 | Cost cap mechanism | **Post-run accounting + hard 600s inference timeout** (no live abort in v1) | Fix M-9 |
| 6 | x402 facilitator | **CDP mainnet facilitator** (requires CDP API keys); x402.org for testnet | Fix M-1, fix OQ-5 disposition |
| 7 | Testnet AC | **Yes** — add AC-1a (Base Sepolia smoke) before AC-1 (mainnet smoke) | Fix Q-1 |
| 8 | Cross-wallet cache | **Yes, intentional** — document rationale explicitly | Fix Q-3 |

## Fixes to apply

Apply in section order (header → § 2 → § 4 → § 5 → § 6 → § 8 → § 10).
Each fix lists: audit finding ID, spec section, what to change, what
to keep.

### Fix CHG-LOG. Add v0.2 change-log entry to header

**Location:** SPEC-001 header (after "Change log v0.1").

**Action:** Add a `**Change log v0.2:**` block listing every fix
applied in this pass. Format follows the SPEC-003 v0.3/v0.4 pattern.
Each line: one-sentence summary referencing audit finding ID.

Also bump the `**Version:**` line from `0.1` to `0.2 (<today's date>, round-1 audit closing)`.

Update `**Depends on:**` line:
- Replace `schema head 0024` with `schema head 0027`
- Add `Coinbase CDP x402 facilitator (mainnet); x402.org reference facilitator (testnet)`

### Fix M-3. Migration number is wrong (header + § 4 Part E + § 5.3)

**Audit finding:** M-3 — current schema head is 0027, not 0024.

**Locations:**
- Header `**Depends on:**` line (fix above)
- FR-E3: change "next migration (0025, conventionally)" to "next migration (0028)"
- § 5.3 heading: `Migration 0025 contract` → `Migration 0028 contract`
- § 5.3 SQL block: confirm syntax against existing migrations in `apps/web/db/migrations/`

**Verification:** `ls apps/web/db/migrations/ | sort | tail -5` should
show 0027 as the highest before 0028.

### Fix M-1. x402 v2 protocol throughout (FR-A2, § 5.1, § 6.1)

**Audit finding:** M-1 — spec uses x402 v1 payload but current official
docs are v2-first; package names in spec don't exist.

**Default applied:** Migrate spec to x402 v2 end-to-end.

**FR-A2 changes:**

Replace the entire 402-response payload example with the v2 shape:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxAmountRequired": "500000",
      "payTo": "<antfleet treasury address from ANTFLEET_X402_TREASURY env>",
      "resource": "https://www.antfleet.dev/api/v1/review/x402",
      "description": "AntFleet two-model-consensus PR review (Opus 4.7 + GPT-5)",
      "mimeType": "application/json",
      "maxTimeoutSeconds": 600
    }
  ],
  "error": "PAYMENT-REQUIRED"
}
```

(Note: `network` becomes the CAIP-2 string `eip155:8453`, not `base`.
`error` becomes `PAYMENT-REQUIRED` per v2.)

In the FR-A2 prose:
- Replace `X-PAYMENT` header references with `PAYMENT-SIGNATURE`.
- Replace `Coinbase x402 v1` with `Coinbase x402 v2` throughout.
- Add a sentence: "Successful response includes the `PAYMENT-RESPONSE`
  header containing the settled payment details (per x402 v2 spec)."

**§ 5.1 endpoint contract table changes:**

- "Required headers" row: replace `X-PAYMENT` with `PAYMENT-SIGNATURE`.
- Add new row: "Response header on 2xx: `PAYMENT-RESPONSE` (settlement details)"

**§ 6.1 dependency table changes:**

Replace the first row (`@coinbase/x402` / `@quicknode/x402`) with:

| `@x402/core` + `@x402/express` + `@x402/evm` | x402 v2 protocol primitives, Express middleware, EVM payment handling | Apache-2.0 (verify at install) | Current official packages per x402.org docs. Pin specific versions in `package.json`. |

Add new row:

| Coinbase CDP API SDK | Auth for CDP mainnet facilitator | Apache-2.0 | Requires `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` env vars. CDP-hosted facilitator chosen for mainnet (free public x402.org facilitator is testnet-only). |

### Fix M-2. Refund-via-defer-settle mechanism (FR-A9 rewrite)

**Audit finding:** M-2 — `/void` is not a standard facilitator
operation; v1 spec implied it was.

**Default applied:** Verify-then-defer-settle. Never settle a payment
until terminal state is known.

**FR-A9 full rewrite:**

```
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
     `validAfter` / `validBefore` window (set to ~10 minutes by the
     skill runner) and expires unused. No USDC ever leaves the caller's
     wallet.

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
```

**Knock-on changes:**

- § 10 OQ-5 "current position" — update to: "CDP mainnet facilitator
  with explicit `verifyOnly` configuration (defer settlement to
  post-terminal). x402.org testnet facilitator for AC-1a."
- Remove all references to "void" or "voiding" elsewhere in the spec.
  Replace with "the authorization expires unused" or "no `/settle`
  call is made."

### Fix C-1 + C-2. Terminal-state taxonomy aligned with production (FR-A6, FR-A8)

**Audit findings:** C-1 (private repo refund contradiction) and
C-2 (terminal-state taxonomy mismatch).

**Action:** Read `apps/web/lib/paywall/refund.ts` first to capture the
ACTUAL production taxonomy. The v0.1 spec invented terms
(`provider_error`, `user_error`, `internal_error`, `timeout`,
`cost_cap_exceeded`) that don't match the storage layer.

The production taxonomy uses:
- Storage: `review_jobs.status` (`queued`, `running`, `complete`,
  `failed`, `expired`) + `review_jobs.failure_mode` (enum of refund-
  eligible vs not).
- Refund-eligible `failure_mode` values per `refund.ts`: `provider_error`,
  `timeout`, `internal`.
- Non-refund-eligible: `user_input`, `validation`.

**FR-A8 full rewrite:**

```
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

Rationale for `user_input` settling (the audit's C-1 fix): a private
repo or non-existent PR is a caller mistake. The review worker still
performed setup work (PR resolution attempt, repo fetch attempt) and
the caller's input is what failed. Channel-rail charges for `user_input`
today; x402-rail matches.
```

**FR-A6 changes:**

In the prose where v0.1 said:
> "If the target repo is private (404 on unauthenticated fetch), the worker MUST terminate the job with status `user_error` and `error_code = repo_not_accessible`. Payment is refunded per FR-A9."

Replace with:
> "If the target repo is private or not accessible via unauthenticated GitHub API (404, 403), the worker MUST terminate the job with status `failed`, `failure_mode = 'user_input'`, and `error_code = 'repo_not_accessible'`. Per FR-A8, this state settles — the caller is charged because the review worker performed setup work against a target it cannot serve."

### Fix M-4. SHA-only constraint (FR-A7, § 5.1, FR-E1)

**Audit finding:** M-4 — pipeline requires `prNumber`; SHA-only is not
a real path.

**Default applied:** SHA must resolve to exactly one open PR head;
otherwise rejected as `user_input`.

**FR-A7 changes (idempotency key shape):**

Update the key derivation paragraph to clarify:

```
The idempotency key is `sha256(caller_wallet || ":" || owner || "/" || repo || ":" || resolved_pr_number || ":" || resolved_sha)`.

For `{"target": {"pr": <n>, "repo": "..."}}` input, `resolved_pr_number`
is `<n>` and `resolved_sha` is the head SHA of that PR at enqueue time.

For `{"target": {"sha": "<hex>", "repo": "..."}}` input, the worker MUST
resolve the SHA to its corresponding open PR head:
- If exactly one open PR in the repo has `head.sha == <hex>`, set
  `resolved_pr_number` accordingly and proceed.
- If zero open PRs match, terminate as `failed`/`failure_mode='user_input'`
  with error_code `sha_not_in_open_pr`.
- If more than one open PR matches (unusual but possible for branches
  cherry-picked across PRs), terminate as `failed`/`failure_mode='user_input'`
  with error_code `sha_ambiguous`.

True SHA-only review (review a commit without a PR context) is OUT OF
SCOPE for v1; the constraint above is documented in § 2.2.
```

**FR-E1 changes:**

Remove the parenthetical `(or null for SHA-only)` after `prNumber`.
Replace with: "`prNumber` is always a resolved integer per FR-A7."

**§ 5.1 endpoint contract table changes:**

In the "Body shape" row, keep both forms (PR= and SHA=) but add a
clarifying note: "SHA targets are resolved to their open PR before
enqueue per FR-A7."

**§ 2.2 out-of-scope additions:**

Add to the OOS list:
- "True SHA-only review (review a commit without an open-PR context).
  v1 requires SHA targets to resolve to exactly one open PR head."

### Fix M-5. Async response shape matches existing route (FR-A5, § 5.1)

**Audit finding:** M-5 — spec returned `pollUrl`/`status`; existing
route returns `statusUrl`/`expectedDurationSec`.

**FR-A5 changes:**

Update the step-2 body example from:

```json
{"jobId": "<uuid>", "status": "queued", "pollUrl": "/api/v1/review/x402/<uuid>"}
```

to:

```json
{
  "jobId": "<uuid>",
  "statusUrl": "/api/v1/review/x402/<uuid>",
  "expectedDurationSec": <int>
}
```

Where `expectedDurationSec` is computed identically to the existing
channel-rail route (consult that route's logic; do not invent a new
estimator).

**§ 5.1 endpoint contract table changes:**

- 202 row: update body to `{"jobId": "<uuid>", "statusUrl": "...", "expectedDurationSec": <int>}`.
- 200 row: same shape but with `status: "complete"` or other terminal
  state included.

### Fix M-6. Error envelope matches existing API conventions (FR-C1, FR-D1, § 5.1)

**Audit finding:** M-6 — spec used flat `{error, code}`; existing
envelope is `{error: {code, message}}`.

**FR-C1 changes:**

Replace the 403 body example:

```json
{
  "error": {
    "code": "aeon_context_required",
    "message": "x402 reviews currently restricted to aeon callers; broader access planned for v2"
  }
}
```

Add: "The 403 envelope follows the existing `jsonError()` helper in
`apps/web/lib/api-v1/responses.ts`. All x402 error responses use this
envelope."

**FR-D1 changes:**

Replace the 429 body example:

```json
{
  "error": {
    "code": "rate_limited_wallet",
    "message": "Rate limit exceeded: 10 reviews per wallet per hour"
  },
  "retry_after_seconds": <int>
}
```

(Note: `retry_after_seconds` stays at the top level alongside `error`
because it's not a message field — it's metadata. This matches existing
rate-limit response shape; confirm against any existing rate-limit
route in the repo before finalizing.)

**§ 5.1 endpoint contract table changes:**

Update every error row (402, 403, 429) to show the `{error: {code, message}}` envelope.

### Fix M-7. New review-level receipt surface (FR-E2, OQ-4 close, § 2.1)

**Audit finding:** M-7 — `/receipts/{id}` is finding-level; spec needs
a review-level surface.

**Default applied:** Create NEW review-level receipt surface at
`/receipts/review/{review_id}`. Existing finding-level surface
`/receipts/{finding_id}` is untouched.

**FR-E2 full rewrite:**

```
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
```

**OQ-4 disposition (in § 10):**

Mark OQ-4 as **CLOSED** in the v0.2 OQ list. Add a closing note:

> **OQ-4 (CLOSED in v0.2).** Current `/receipts/{id}` routes through
> `finding_id`, not `review_id` (verified at `apps/web/db/queries.ts:1053`
> and `apps/web/app/receipts/[id]/page.tsx:21`). SPEC-001 v0.2 creates a
> distinct review-level surface at `/receipts/review/{review_id}`;
> finding-level surface untouched.

**§ 2.1 Part E additions:**

Add to the in-scope list:
- "A new public review-level receipt page at
  `antfleet.dev/receipts/review/{review_id}` (existing finding-level
  receipts at `antfleet.dev/receipts/{finding_id}` untouched). See FR-E2."

### Fix M-8. Gate clock skew + secret rotation (FR-C2, FR-C3 unchanged)

**Audit finding:** M-8 — token mechanics omit clock skew, key
identifier, rotation.

**FR-C2 full rewrite:**

```
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
```

**FR-C3 invariant unchanged.** No edits needed.

### Fix M-9. Cost cap → post-run accounting + hard timeout (FR-D3)

**Audit finding:** M-9 — pipeline doesn't expose live cost streaming
or abort signals; v0.1 spec was unimplementable.

**Default applied:** Drop active mid-flight kill. Use post-run cost
accounting + hard 600s inference wall-clock timeout (which already
exists per the x402 `maxTimeoutSeconds: 600` config).

**FR-D3 full rewrite:**

```
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
```

### Fix m-1. Header naming consistency (FR-C1, FR-B3)

**Audit finding:** m-1 — spec alternates `X-Aeon-Context` and
`Aeon-Context`.

**Action:** Use `X-Aeon-Context` everywhere. Grep the spec for
`Aeon-Context` and ensure every match has the `X-` prefix.

### Fix m-2. AC-7 idempotency reference (AC-7)

**Audit finding:** m-2 — AC-7 cites FR-A7 (x402 idempotency) but
the channel-rail caching it describes comes from existing channel
idempotency.

**Action:** In AC-7 step 2, replace:

> "Skill invocation returns cached result (FR-A7 idempotency), no second debit."

with:

> "Skill invocation returns the cached channel-rail result via the existing channel idempotency mechanism (see `apps/web/app/api/v1/installations/[id]/review/route.ts` and `apps/web/lib/review-job-queries.ts`), no second debit. This is not FR-A7 (which scopes x402 idempotency only)."

### Fix m-3. Remove `siwe` from v1 dependencies (§ 6.1)

**Audit finding:** m-3 — `siwe` is listed in v1 deps but spec says
"NOT a hard v1 dep."

**Action:** Remove the `siwe` row from the § 6.1 backend dependency
table. Add a one-line note at the end of § 6.1: "`siwe` is intentionally
NOT a v1 dependency; stateless x402 v2 payment-as-auth suffices. If v2
extends to JWT sessions, `siwe` will be added in that revision's spec."

### Fix Q-1. Add testnet AC (AC-1a, before AC-1)

**Audit finding:** Q-1 — AC-1 is mainnet-only; deterministic testnet
AC is desirable.

**Default applied:** Add AC-1a (Base Sepolia smoke) before AC-1
(mainnet smoke). AC-1a runs against the x402.org reference facilitator
on Sepolia; AC-1 stays as the production-equivalent mainnet smoke
against CDP facilitator.

**Add new AC-1a:**

```
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
```

Renumber existing AC-1 to remain "AC-1" (mainnet smoke) but add to
its description: "AC-1 is the production-equivalent mainnet equivalent
of AC-1a. AC-1a is gating for every CI build; AC-1 is run manually
before each production release."

### Fix Q-3. Document cross-wallet cache as intentional (FR-D2)

**Audit finding:** Q-3 — confirm cross-wallet cache (W2 gets W1's
paid result free) is intentional.

**Default applied:** Yes, intentional. Document explicitly.

**FR-D2 additions:**

Add a paragraph at the end of FR-D2:

```
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
```

### Fix Q-2. Note re receipt schema additive change (FR-E2)

**Audit finding:** Q-2 — external consumers of receipts may break if
strict-matching JSON.

**Action:** Add a paragraph at the end of FR-E2:

> "The `paid_via` field added to the receipt JSON shape is OPTIONAL
> and additive. External consumers (Aeon dashboard, Aaron's tooling,
> any third-party scraper) that use strict JSON schema validation
> should add `paid_via` as an optional string field. AntFleet will not
> break-change the receipt schema without a version bump documented
> here. Compatibility verification with known consumers is operator
> responsibility before the v0.2 implementation lands."

### Fix Q-4. Pin package versions after install verification

**Audit finding:** Q-4 — package names not verified at npm registry.

**Action:** In § 6.1 dependency table (already updated in fix M-1),
add a note at the end of the table:

> "All packages listed MUST be verified to exist on the npm registry
> and pinned to a specific version in `apps/web/package.json` before
> implementation begins. The build prompt is gated on this verification."

### Fix new ACs. Cover missing FRs (AC-9, AC-10, AC-11, AC-12)

**Audit finding:** The AC coverage matrix flagged FR-C3 (removability),
FR-D3 (cost cap), FR-E3 (migration) as having no AC.

**Add AC-9 through AC-12:**

```
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
1. `review_jobs` table gains `caller_wallet text` (nullable) and
   `payment_rail text not null default 'channel' check (payment_rail in ('channel','x402'))`.
2. All existing rows have `payment_rail = 'channel'` after backfill.
3. Indexes `idx_review_jobs_caller_wallet` and
   `idx_review_jobs_payment_rail_created` exist.
4. `failure_mode` enum includes `cost_cap_exceeded` (this enum
   addition is part of migration 0028 per fix C-2).
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
```

**Update § 8 header pass-rule:**

Change "AC-1 through AC-8" to "AC-1 (including AC-1a), AC-2 through AC-12".

### Final cleanup pass

After all fixes applied:

1. Grep the spec for any remaining `user_error`, `provider_error` (as
   standalone status — they should only appear as `failure_mode` values
   per the new taxonomy), `internal_error`, `pollUrl`, `X-PAYMENT`,
   `void` (in refund context), `Coinbase x402 v1`, `@coinbase/x402`,
   `@quicknode/x402`, `migration 0025`, `schema head 0024`,
   `Aeon-Context` without `X-` prefix. Any remaining instance is a
   missed fix.

2. Grep for "siwe" — should appear only in the closing v0.1 note,
   not in the dep table.

3. Confirm the change-log v0.2 entry references every audit finding
   addressed (C-1, C-2, M-1 through M-9, m-1 through m-3, Q-1, Q-2,
   Q-3, Q-4).

4. Verify § 10 OQ list: OQ-4 marked CLOSED with disposition; OQ-5
   updated to reflect CDP-mainnet/x402.org-testnet decision; OQ-1,
   OQ-2, OQ-3 unchanged (still real operator decisions).

5. Verify § 8 ACs total 12 (1, 1a, 2–12).

6. Verify spec compiles as readable markdown (no broken tables, no
   unclosed code fences).

## Process

1. Read the required materials above.

2. Read SPEC-001 v0.1 fully so you know what's there.

3. Apply fixes in section order: CHG-LOG → M-3 → M-1 → M-2 → C-1/C-2 →
   M-4 → M-5 → M-6 → M-7 → M-8 → M-9 → m-1 → m-2 → m-3 → Q-1 → Q-2 →
   Q-3 → Q-4 → new ACs → cleanup pass.

4. Self-review pass (cleanup checklist above).

5. Print a 250-word handback summary to stdout listing:
   - Version bump applied (v0.1 → v0.2)
   - Count of audit findings addressed by category
   - Confirmation: dual-rail isolation invariant preserved
   - Confirmation: aeon-gate removability invariant preserved
   - Confirmation: v1 scope discipline preserved (no OOS items pulled in)
   - Any blockers encountered (e.g. a baked-in default that proved
     impossible to honor)
   - Spec line count before/after

6. Do NOT commit. Operator reviews + commits.

## What NOT to do

- Do NOT edit any source code, migrations, or other spec documents.
- Do NOT pick a different default for the 8 operator decisions
  silently. If a default is impossible to honor, stop and document.
- Do NOT pull in any v2-deferred content (Bankr listing, sybil
  scoring, adversarial-input hardening, private-repo-via-x402,
  PR-comment-posting-in-x402-mode). The § 2.2 OOS list is unchanged.
- Do NOT modify the aeon-gate removability invariant (FR-C3).
- Do NOT modify the pipeline reuse invariant (FR-E1).
- Do NOT add new FRs beyond what's prescribed (the new ACs add
  coverage for existing FRs; no new FRs are introduced).
- Do NOT commit. Operator commits.

## Expected size of diff

  SPEC-001 v0.1 → v0.2: substantial. Estimated ~400-600 lines changed
  out of ~1100 total. Major rewrites:
    - FR-A8 / FR-A9 (terminal-state taxonomy)
    - FR-A2 (x402 v2 payload)
    - FR-A9 (verify-then-defer-settle)
    - FR-C2 (gate token + rotation)
    - FR-D3 (cost cap mechanism)
    - FR-E2 (receipt surfaces)
    - § 8 ACs (4 new + AC-7 reference fix)

If diff exceeds ~800 lines you've likely introduced content beyond the
prescribed fixes. Stop and audit your changes against this prompt.

When done, print the handback summary and stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist:

1. **Diff scope** — `git diff specs/SPEC-001-aeon-x402.md | wc -l`
   should be in the 400–700 range. Wildly larger = scope creep.
2. **Cleanup grep pass** — `grep -nE 'user_error|provider_error\.status|internal_error|pollUrl|X-PAYMENT|Coinbase x402 v1|@coinbase/x402|@quicknode/x402|migration 0025|schema head 0024' specs/SPEC-001-aeon-x402.md`
   should return zero matches.
3. **AC count** — § 8 should list AC-1, AC-1a, AC-2 through AC-12
   (13 total).
4. **OQ disposition** — § 10 should show OQ-4 CLOSED, OQ-5 updated,
   OQ-1/2/3 unchanged.
5. **Change log** — v0.2 entry should reference every audit finding
   ID (C-1, C-2, M-1..M-9, m-1..m-3, Q-1..Q-4).
6. **Invariants** — dual-rail isolation and aeon-gate removability
   text preserved in FR-E1 and FR-C3.

Then commit. Suggested message:

```
SPEC-001 v0.2: round-1 audit closing fixes

Closes all 18 round-1 audit findings (2 CRITICAL, 9 MAJOR, 3 MINOR,
4 QUESTION).

CRITICAL  C-1, C-2: Terminal-state taxonomy aligned with production
                    channel rail (status='failed' + failure_mode).
                    Private repo = user_input (settles, not refunds).

MAJOR     M-1: x402 v2 protocol throughout (headers, payload,
               CAIP-2 network IDs, @x402/* packages).
          M-2: Verify-then-defer-settle (no /void, no pending_refunds).
          M-3: Migration 0025 → 0028 (current head was stale).
          M-4: SHA-only constrained to PR-resolved SHA.
          M-5: Async response shape matches existing route.
          M-6: Error envelopes use jsonError() {error: {code, message}}.
          M-7: New review-level receipt surface at
               /receipts/review/{review_id}; finding-level untouched.
          M-8: Gate token gains kid + clock skew + rotation protocol.
          M-9: Cost cap = post-run accounting + hard 600s timeout
               (no live abort in v1; documented).

MINOR     m-1: X-Aeon-Context everywhere.
          m-2: AC-7 references channel idempotency, not FR-A7.
          m-3: siwe removed from v1 deps.

QUESTIONS Q-1: Added AC-1a (Base Sepolia testnet smoke).
          Q-2: Receipt schema additive change documented.
          Q-3: Cross-wallet cache documented as intentional.
          Q-4: Package versions pinned (gating impl).

Invariants preserved: dual-rail isolation, aeon-gate removability,
v1 scope discipline (no OOS items pulled in).

Audit re-run: full (per macprovider house style after CRITICAL).
```

After commit, run **AUDIT_SPEC_001_PROMPT.md again** (full, not narrow,
because round-1 had CRITICALs). Expected v0.2 verdict: READY TO BUILD
or NEEDS REVISION with ≤3 narrow MAJORs.

- If READY TO BUILD: write `BUILD_SPEC_001_IMPL_PROMPT.md`. Implementation begins.
- If NEEDS REVISION: write `FIX_SPEC_001_V0_2_PROMPT.md` (should be small) and re-audit narrow.

Expected total path from here: 1 more audit round, then implementation.
Target: SPEC-001 locked by 2026-06-02 so the ~1-week build can ship by 2026-06-09.
