# Fix prompt — SPEC-001 v0.4 implementation audit closing → v1 launch-ready

Operator-paste prompt to apply the implementation audit findings from
`specs/SPEC-001-impl-audit.md` (multi-agent workflow audit, 2026-05-29)
against commit `e4475b8` "Enable x402 pay-per-review without channel onboarding".

This fix pass addresses **ALL 31 findings**: 1 CRITICAL + 11 MAJOR + 14 MINOR + 5 QUESTIONS.

Scope spans:
- **Spec edits** to `specs/SPEC-001-aeon-x402.md` (v0.4 → v0.5)
- **Code fixes** in `apps/web/` (timeout, ordering, header, receipt query, copy)
- **5 new automated tests** to close AC coverage gaps
- **10 MINOR + 5 QUESTION** polish items
- **Cross-repo Part B work**: create `antfleet/aeon-skills :: pr-review-antfleet-x402/` + open one-line PR to `aaronjmars/aeon`

Run in **Codex CLI** (cross-model: Claude wrote the spec and ran the audit; Codex applies the fix). Expected duration: ~4–6 hours for P0+P1 in one pass; P2+P3 can ride a follow-up pass.

Paste everything between `=== BEGIN PROMPT ===` and `=== END PROMPT ===`
into a fresh Codex session rooted at `/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are applying the SPEC-001 v0.4 implementation audit findings against
commit e4475b8. The audit report at specs/SPEC-001-impl-audit.md returned
verdict NEEDS REVISION with 1 CRITICAL + 11 MAJOR + 14 MINOR + 5 QUESTION
findings.

Your scope is comprehensive: address ALL findings, prioritized P0 → P3.

Targets:
- specs/SPEC-001-aeon-x402.md  v0.4 → v0.5  (FR-A2 reconciliation + FR-E3 column docs + minor clarifications)
- apps/web/**                  code fixes + 5 new tests
- Cross-repo Part B (CRITICAL launch blocker):
  - antfleet/aeon-skills::pr-review-antfleet-x402/  (NEW folder, opened as PR)
  - aaronjmars/aeon::skill-packs.json + docs        (NEW one-line PR)

## Critical constraints (load-bearing)

**1. Dual-rail isolation invariant (FR-E1).** All three load-bearing
invariants currently HOLD per the audit. Do NOT regress any of them:
- `apps/web/lib/review-pipeline.ts` `reviewPR()` MUST remain byte-unchanged.
- No new `if (paymentRail === 'x402')` branching inside the pipeline.
- Worker dispatch (`review-job-worker.ts`) is the ONLY place rail
  branching is permitted.

**2. Aeon-gate removability invariant (FR-C3).** The
`X402_REQUIRE_AEON_CONTEXT=false` short-circuit MUST continue to work.
Do NOT introduce new gate dependencies that require code changes to bypass.

**3. Channel-rail no-regression (AC-7).** The existing channel-rail
test suite passes 107 tests across 18 files. After this fix, every one
of those tests MUST continue to pass without modification.

**4. Source-of-truth alignment.** When fixing a code-vs-spec drift,
read both first. Two specific drifts (FR-A2 payload shape, receipt
query rail-restriction) have operator-decided defaults baked in below.

**5. No `--no-verify` on commits.** Pre-commit hooks exist for a reason.

**6. Git identity for commits to this repo.** Use the
`antfleet-ops` gh account; commit identity is already configured. Do
NOT switch git config. If you need to push, run
`gh auth switch -u antfleet-ops` before any write op.

**7. Cross-repo commits use the same identity.** The Part B PRs to
`antfleet/aeon-skills` (AntFleet org) and `aaronjmars/aeon` (external)
both ride on `antfleet-ops`. Do NOT switch accounts.

## Operator decisions baked in as defaults

The audit surfaced 2 operator-gating drift decisions. Defaults below
are chosen; if a default proves impossible to honor, STOP and document.

| # | Drift | Default | Rationale |
|---|---|---|---|
| 1 | FR-A2 payload shape (spec literal vs @x402/core v2 schema) | **Amend SPEC v0.5 to mirror @x402/core v2 schema** | Code is what x402 facilitators actually consume; spec literal was written before package landed on v2 shape |
| 2 | Receipt query rail-restriction (code forces `payment_rail='x402'`, spec implies rail-agnostic) | **Fix code (LEFT JOIN, drop predicate)** | Rail-agnostic is the cleaner abstraction; future channel-rail review_id-level receipts get the surface for free |

## Required reading (in order)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-impl-audit.md
   — read fully. This is your authoritative finding list. Pay particular
   attention to the per-finding "Fix" lines — each prescribes the
   resolution.

2. /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md v0.4
   — read the sections you'll edit: FR-A2 (full rewrite for default #1),
   FR-A8 (`expired` terminal state addition), FR-D1 (ordering invariant
   re-emphasis), FR-E2 (rail-agnostic clarification), FR-E3 (column
   enumeration update for migration 0028's actual columns).

3. Code files you'll edit (read them BEFORE editing):
   - apps/web/app/api/v1/review/x402/route.ts
   - apps/web/app/api/v1/review/x402/[jobId]/route.ts
   - apps/web/lib/review-job-worker.ts
   - apps/web/lib/x402/facilitator.ts
   - apps/web/lib/x402/rate-limit.ts
   - apps/web/lib/x402/env.ts
   - apps/web/lib/x402/aeon-gate.ts
   - apps/web/lib/x402/implementation-notes.md
   - apps/web/db/queries.ts (around line 1155 — receipt query)
   - apps/web/app/receipts/review/[id]/page.tsx
   - apps/web/app/.well-known/antfleet.json/route.ts
   - apps/web/app/page.tsx (around lines 412-413)
   - apps/web/public/llms.txt
   - apps/web/lib/paywall/refund.ts (revert cost_cap_exceeded leak)
   - apps/web/db/migrations/0028.test.ts (real apply test)
   - apps/web/db/seed/x402-receipt-test-fixtures.ts (for AC-12 reference)

4. Cross-repo Part B references:
   - https://github.com/antfleet/aeon-skills (clone for Part B)
   - https://github.com/antfleet/aeon-skills/blob/main/pr-review-antfleet/SKILL.md (mirror this structure)
   - https://github.com/antfleet/aeon-skills/blob/main/pr-review-antfleet/run.mjs (mirror with x402 twist)
   - https://github.com/aaronjmars/aeon/blob/main/skill-packs.json (one-line PR target)
   - https://docs.x402.org/guides/migration-v1-to-v2 (FR-A2 shape reference)

## Fixes — apply in priority order

Apply P0 first (must land before mainnet). Stop after P0 if you want
operator review before continuing. P1 should follow in the same session
if possible (closes test gaps). P2 + P3 can be a follow-up pass.

---

### P0 — Must land before mainnet AC-1

**P0.1 — Implement FR-D3 Layer 1 wall-clock timeout (MAJOR #1)**

Location: `apps/web/lib/review-job-worker.ts:309` (the `await reviewPR(...)` call).

Wrap the `reviewPR()` call in `Promise.race()` against a 600-second
timer. On timeout, throw a typed error so the existing
`classifyError()` + `handleX402JobFailure()` path tags `failure_mode='timeout'`
and the facilitator settle is skipped.

```typescript
// Pseudocode — adapt to surrounding code style:
const TIMEOUT_MS = (process.env.X402_MAX_TIMEOUT_SECONDS
  ? Number(process.env.X402_MAX_TIMEOUT_SECONDS)
  : 600) * 1000;

class WallClockTimeoutError extends Error {
  constructor() {
    super('reviewPR exceeded wall-clock timeout');
    this.name = 'WallClockTimeoutError';
  }
}

const bundle = await Promise.race([
  reviewPR(/* existing args */),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new WallClockTimeoutError()), TIMEOUT_MS),
  ),
]);
```

Update `classifyError()` to recognize `WallClockTimeoutError` and
return `failure_mode: 'timeout'` (use whatever literal the existing
classifier uses for the existing 'timeout' string match).

Add a worker-test case in `apps/web/lib/review-job-worker.x402.test.ts`
that mocks `reviewPR` to hang for >600s (use vitest fake timers); assert
job ends `failed`/`failure_mode='timeout'`, `facilitator.settlePayment`
not called.

Add `X402_MAX_TIMEOUT_SECONDS=600` to env.ts validation (optional
override; default 600).

**P0.2 — Reorder route.ts: rate-limit + cooldown BEFORE verifyPayment (MAJOR #2)**

Location: `apps/web/app/api/v1/review/x402/route.ts:167-191`.

Current order:
1. aeon-gate check
2. **verifyPayment**
3. cooldown check
4. rate-limit check

New order (per FR-D1: "429 response does NOT consume payment"):
1. aeon-gate check
2. target resolution (parse PR/SHA from body, resolve SHA→PR if needed)
3. **cooldown check** (per repo+sha)
4. **rate-limit check** (per wallet — but wallet identity needs to come from somewhere)
5. verifyPayment (only if 3+4 pass)
6. idempotency check
7. createJob + scheduleWorker

**Wallet identity for rate-limit before verify:** Extract signer
address from the unverified `PAYMENT-SIGNATURE` header by base64-decoding
the payload and reading the `authorization.from` field WITHOUT
cryptographic verification. This is safe because: (a) a forged signer
field doesn't grant the attacker any service — it only counts against
THAT address's rate-limit budget; (b) the genuine verifyPayment downstream
catches signature fraud and rejects with 402 anyway.

Add a helper in `apps/web/lib/x402/facilitator.ts`:

```typescript
/**
 * Extract the claimed signer address from a PAYMENT-SIGNATURE header
 * WITHOUT cryptographic verification. Used for pre-verify rate-limit
 * lookup; the real verify happens downstream.
 *
 * Returns null if the header is missing or malformed.
 */
export function extractClaimedSigner(headerValue: string | null): `0x${string}` | null {
  if (!headerValue) return null;
  try {
    const decoded = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf-8'));
    const from = decoded?.payload?.authorization?.from;
    if (typeof from === 'string' && /^0x[a-fA-F0-9]{40}$/.test(from)) {
      return from.toLowerCase() as `0x${string}`;
    }
    return null;
  } catch {
    return null;
  }
}
```

Update route.ts to call `extractClaimedSigner()` before rate-limit
lookup. If null, treat as "no wallet" → 402 directly (skip rate-limit;
caller hasn't even attempted payment yet).

Update the existing test in `route.test.ts` to assert the new order
(spy on `deps.verifyPayment` — confirm it's NOT called when rate-limit
or cooldown rejects).

**P0.3 — Attach PAYMENT-RESPONSE header on terminal settled poll (MAJOR #4)**

Location: `apps/web/app/api/v1/review/x402/[jobId]/route.ts:43-57`.

Currently returns JSON only. Spec FR-A2 step 4 mandates the header on
terminal 2xx settling responses.

When the polled job is in terminal state `complete` AND
`settlement_status='settled'`, attach:
- Header: `PAYMENT-RESPONSE: <base64-encoded settlement details>`
- Header: `Access-Control-Expose-Headers: PAYMENT-RESPONSE` (so cross-
  origin callers can read it)

Build the header value by rebuilding from `job.x402_settlement_response`
(already persisted per FR-A4b). The `facilitator.ts:151`
`paymentResponseHeader` helper already constructs it — reuse it.

Add a poll-route test case asserting the header is present on settled
responses and ABSENT on non-settled (in-flight, failed, expired).

**P0.4 — Reconcile FR-A2 spec ↔ code (MAJOR #3) — OPERATOR DEFAULT: AMEND SPEC**

Location: `specs/SPEC-001-aeon-x402.md` FR-A2.

The current spec literal (`resource: <URL>`, `maxAmountRequired`,
`description`) was written before `@x402/core` v2 finalized its schema.
The code emits the actually-correct v2 schema:
- `resource: {url, description, mimeType, serviceName, tags}` (object, not string)
- Per-entry: `amount` instead of `maxAmountRequired`; `extra` instead of inline `description`

Rewrite FR-A2's example payload to mirror what `facilitator.ts:49-72`
actually emits. Cross-reference https://docs.x402.org/guides/migration-v1-to-v2
to confirm v2 shape.

Add to the FR-A2 prose:

> "The 402 payload shape mirrors `@x402/core` v2 schema, which is the
> normative reference for what x402 v2 facilitators expect. The
> AntFleet implementation uses `buildPaymentRequired()` in
> `apps/web/lib/x402/facilitator.ts` to construct the payload; the
> spec example here is illustrative — the implementation is the
> source of truth."

Bump spec to v0.5 in header. Add v0.5 change log entry covering this
fix and all other v0.5 spec edits (see P0.5, P0.6, P2 spec edits).

**P0.5 — Fix receipt query to be rail-agnostic (MAJOR #10) — OPERATOR DEFAULT: FIX CODE**

Location: `apps/web/db/queries.ts:1155` (`loadPublicReviewReceipt` or
similar — find the query that hard-restricts `payment_rail='x402'`).

Change:
```sql
JOIN review_jobs j ON j.x402_review_id = r.review_id AND j.payment_rail = 'x402'
```
to:
```sql
LEFT JOIN review_jobs j ON j.review_id = r.review_id
```

(Adjust the join field per actual schema — the goal is rail-agnostic.
Channel-rail review_jobs MUST also be queryable via the new surface;
they currently 404.)

Update `apps/web/app/receipts/review/[id]/page.tsx` to handle the
case where `payment_rail='channel'` — render the rail tag faithfully,
omit any x402-specific fields (settlement status) for channel rail.

Add a test case in `page.test.tsx` (created in P1.1) that asserts a
channel-rail review_id renders correctly through this surface.

Note: this fix is OUT-of-scope-creep adjacent — the existing spec
talked about a review-level receipt that x402 callers receive. Making
it rail-agnostic is an extension; document it in implementation notes.

**P0.6 — Add aeon-gate disclosure to public copy (MAJOR #11)**

Three files need a one-line disclosure that x402 access is currently
gated to aeon-ecosystem callers:

1. `apps/web/public/llms.txt` — add a line under the x402 section:
   "Access in v1 is restricted to aeon-ecosystem callers (requires
   `X-Aeon-Context` header); broader public access planned for v2.
   Non-aeon callers will receive HTTP 403."

2. `apps/web/app/page.tsx:412-413` (landing prose) — append to the
   "Public repos use x402 pay-per-review by default" sentence:
   "(v1 restricted to aeon-ecosystem callers; broader access planned
   for v2)."

3. `apps/web/app/.well-known/antfleet.json/route.ts` — add an
   `access_scope` field to the x402 endpoint declarations:
   ```json
   "access_scope": "aeon-ecosystem-callers-only-v1"
   ```

Update the `route.test.ts` for the manifest endpoint to assert the
new field is present on x402 entries.

---

### P1 — Must land before Part B PR opens (close test gaps)

**P1.1 — Add AC-12 review-receipt-page integration test (MAJOR #5)**

Create `apps/web/app/receipts/review/[id]/page.test.tsx`.

The spec § 8 AC-12 mandates this exact path. Reference the three seed
rows in `apps/web/db/seed/x402-receipt-test-fixtures.ts`:
- Row 1: `status=complete`, 2 findings → assert both findings render
  with links to existing finding-level receipts
- Row 2: `status=complete`, 0 findings → assert exact copy
  `No findings — clean review.` (with EM-DASH per AC-12 — see P1.7)
- Row 3: `status=failed`, `failure_mode='provider_error'` → assert
  exact copy `Payment not settled` literal renders (see P1.7)

Also assert (per P0.5) that a channel-rail review_id renders correctly
(no settlement-status field, rail tag shows `channel`).

**P1.2 — Add AC-6 cross-wallet cooldown test (MAJOR #6)**

Location: `apps/web/app/api/v1/review/x402/route.test.ts`.

Add a case where `deps.findRecentRepoShaJob` returns an existing
`complete` job from a DIFFERENT wallet. Assert:
- 200 status (not 202 — cached hit)
- Response body mirrors the existing job's terminal payload
- `deps.verifyPayment` NOT invoked (no second payment)
- `deps.createJob` NOT invoked (no new row)
- Per-wallet rate-limit budget NOT consumed for the second wallet
  (assert `deps.recordRateLimit` not called — or whatever the actual
  recording mechanism is)

**P1.3 — Add AC-10 cost-cap branch test (MAJOR #7)**

Location: `apps/web/lib/review-job-worker.x402.test.ts`.

Add a `processReviewJob` case where `reviewPR` returns a bundle with
`estimatedCostUsd > 1.5` (= 3× `REVIEW_PRICE_USDC`). Assert:
- `facilitator.settlePayment` NOT called
- `markX402JobFailedWithResultAndSettlement` called with
  `failure_mode='cost_cap_exceeded'`, `settlement_status='not_settled'`
- Authorization NOT consumed (caller wallet balance unchanged in mock)

**P1.4 — Add AC-3 idempotency repeat-POST test (MAJOR #8)**

Location: `apps/web/app/api/v1/review/x402/route.test.ts` (or new
`idempotency.test.ts` per the audit's spec-named file suggestion).

Add a case where `deps.findJobByIdempotencyKey` returns an existing
`complete` job. Assert:
- 200 status (not 202)
- Response body mirrors the existing job's terminal payload
- `deps.createJob` NOT called
- `deps.scheduleWorker` NOT called
- `deps.verifyPayment` NOT called (payment intent voided / never
  submitted to facilitator)

**P1.5 — Replace AC-11 string-grep with real migration apply test (MAJOR #9)**

Location: `apps/web/db/migrations/0028.test.ts`.

Current test only `fs.readFileSync(...)` + greps SQL string. Replace
with a real Postgres testcontainer (or whatever ephemeral PG fixture
the repo already uses for migration tests — check existing patterns):

1. Spin up Postgres at migration head 0027 (use existing migration
   apply infrastructure).
2. Seed at least 2 review_jobs rows (one each: `status=complete`,
   `status=queued`).
3. Run `apply-migration-0028.ts --apply` (programmatically, not via
   shell-out).
4. Assert via `information_schema.columns`:
   - `caller_wallet text` exists, nullable.
   - `payment_rail text NOT NULL DEFAULT 'channel' CHECK (...)` exists.
   - `x402_pay_to text` exists, nullable.
   - All 4 extra x402 columns exist (per actual migration SQL — read
     0028_review_jobs_x402.sql to enumerate).
5. Assert NO `review_jobs_failure_mode_check` constraint exists.
6. Assert backfill: existing rows have `payment_rail='channel'`.
7. Re-run `apply-migration-0028.ts --apply` — assert exit code 0, no
   errors, no duplicate index creation (idempotent).

If the repo uses Vercel Postgres / Neon / sqlite for tests, adapt
accordingly — the goal is to actually apply the migration, not just
parse it.

**P1.6 — Resolve mainnet facilitator URL discrepancy (MINOR #1)**

Location: `apps/web/lib/x402/env.ts:7` vs spec § FR-A4 table.

Code currently hard-codes `api.cdp.coinbase.com/platform/v2/x402`.
Spec table lists `facilitator.cdp.coinbase.com`.

Check which URL is current per https://docs.cdp.coinbase.com/x402/network-support.
Pick the canonical one. Update whichever is stale (code or spec) to
match.

If spec needs updating, add to v0.5 change log.

**P1.7 — Fix AC-12 copy mismatches (MINOR #12)**

Location: `apps/web/app/receipts/review/[id]/page.tsx`.

Two copy bugs the audit found:
1. `page.tsx:69` emits ASCII hyphen `-`; AC-12 mandates em-dash `—`.
2. "Payment not settled" literal never renders; failed-rail rendering
   uses a different string. Add the literal per AC-12.

Both are visible-text-only changes; no logic impact. The AC-12 test
from P1.1 verifies both.

---

### P2 — Polish + remaining MINOR / QUESTION items

**P2.1 — Add startup reachability probe for X402_FACILITATOR (MINOR #2)**

Location: `apps/web/lib/x402/env.ts` (or a sibling startup file).

Per spec § FR-A4 invariant 3: 5-second HEAD/GET probe at startup;
unreachable = warn-only (not fatal). Implement as a fire-and-forget
log warning during env validation:

```typescript
async function probeFacilitator(url: string): Promise<void> {
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5000);
    const res = await fetch(url, { method: 'HEAD', signal: ac.signal });
    if (!res.ok && res.status !== 405) { // 405 = HEAD not allowed, but reachable
      console.warn(`[x402] Facilitator probe returned ${res.status} for ${url}`);
    }
  } catch (err) {
    console.warn(`[x402] Facilitator probe failed for ${url}: ${err}`);
  }
}
```

Call from env validation (don't await — fire-and-forget so startup
doesn't block).

**P2.2 — Implement `expired` terminal state sweep (MINOR #3 + FR-A8 audit gap)**

Location: New file `apps/web/lib/x402/expiry-sweep.ts` + worker hook.

Per spec FR-A8: jobs in `queued` or `running` longer than the EIP-3009
`validBefore` MUST transition to `expired`. Without this, stale jobs
pile up.

Implement as either:
(a) A cron-style sweep that scans for expired-window queued/running
    jobs every 60s, or
(b) A lazy check at poll time: if `GET /api/v1/review/x402/{jobId}`
    hits a job whose `x402_valid_before < now` and status is still
    queued/running, transition to `expired` inline and return.

Option (b) is lighter (no new cron) and aligns with how the poll
handler already inspects job state. Use (b) unless there's a reason
not to.

Update poll handler in `[jobId]/route.ts` accordingly.

Add test case asserting expired transition.

**P2.3 — Don't cache failed jobs in per-repo cooldown (MINOR #4)**

Location: `apps/web/lib/x402/rate-limit.ts:50-61`.

Current cooldown set includes `'failed'` — meaning a cross-wallet
caller hitting the same SHA after a previous failure gets a stale
`provider_error` cached response with 200 status. Wrong behavior.

Change cooldown status set to ONLY `['complete', 'queued', 'running']`
(or whatever the project's enum literals are). Failed jobs should
allow a fresh retry by any caller.

Update P1.2 test (AC-6) and add a sibling test where the existing
job is `failed` — assert the new request proceeds to 202 (no cache
hit on failure).

**P2.4 — Add AC-2 explicit no-rate-limit-budget-consumed test (MINOR #7)**

Location: `apps/web/lib/x402/aeon-gate.test.ts` (or `route.test.ts`).

AC-2 says rejected aeon-context callers don't consume rate-limit
budget. Currently true by construction (early exit before rate-limit
check) but not explicitly tested.

Add a case: invalid `X-Aeon-Context` → 403. Then immediately a valid
call from the same wallet → 202 (or 402 if no payment). Assert
rate-limit budget for that wallet is still full (10/10).

**P2.5 — Add AC-5 rate-limit envelope + retryAfter integer test (MINOR #8)**

Location: `apps/web/app/api/v1/review/x402/route.test.ts`.

Existing rate-limit helper tests check the helper. The HTTP envelope
shape and `retry_after_seconds` integer field are unasserted at the
route level.

Add a case: wallet at quota (10 successful in last hour) → 429.
Assert:
- Body shape: `{error: {code: 'rate_limited_wallet', message: '...'}, retry_after_seconds: <int>}`
- `retry_after_seconds` is an integer between 1 and 3600
- `Retry-After` HTTP header also set (RFC-compliant, optional but good)

**P2.6 — Wire AC-1a smoke into CI (MINOR #9)**

Location: `.github/workflows/` (find existing workflow files).

Add a CI step (probably to the existing test workflow) that runs:
```bash
node apps/web/scripts/x402-live-smoke.ts --network sepolia --skip-on-missing-creds
```

The `--skip-on-missing-creds` flag (add if not present) makes the
script no-op when the testnet wallet private key or Sepolia
facilitator URL aren't set as repo secrets — so unauthenticated CI
runs don't fail.

If Sepolia secrets ARE set: the step runs the real testnet smoke and
fails the build on regression. Operator provisions the secrets when
ready.

Document in implementation notes.

**P2.7 — Remove cost_cap_exceeded from channel-rail refund module (MINOR #10)**

Location: `apps/web/lib/paywall/refund.ts:18-23`.

The audit found `cost_cap_exceeded` was added to channel-rail
`REFUNDABLE_FAILURE_MODES`. Dormant (channel rail never throws it)
but bleeds x402 concept into a channel module — weakens FR-E1
isolation.

Remove `cost_cap_exceeded` from `REFUNDABLE_FAILURE_MODES`. Add it
to a sibling x402-specific refund-eligible set in
`apps/web/lib/x402/review-job-result.ts` (or wherever the worker
consults for x402 refund decisions).

Verify channel-rail tests still pass (they will — the entry was
dormant for channel).

**P2.8 — Update spec FR-E3 to enumerate actual migration 0028 columns (MINOR #11)**

Location: `specs/SPEC-001-aeon-x402.md` FR-E3 + § 5.3.

Migration 0028 adds 6 columns: `caller_wallet`, `payment_rail`,
`x402_pay_to`, plus 3 settlement-state columns (`x402_review_id`,
`x402_authorization`, `x402_settlement_response`, or similar — read
the actual SQL file to enumerate).

Update FR-E3 + § 5.3 SQL block to list all 6, with a one-line note
per column explaining its role. This closes the spec/code drift the
audit flagged.

Document in v0.5 change log.

**P2.9 — Add manifest access_scope field (MINOR #13)**

Already covered in P0.6 step 3. Verify the manifest test asserts
on this field.

**P2.10 — Tighten signer extraction (QUESTION #1)**

Location: `apps/web/lib/x402/facilitator.ts:243-247`.

Current signer-extraction iterates 6 keys (defensive against schema
drift). EIP-3009 always uses `authorization.from` — tighten to read
ONLY that path. Eliminates attacker-controlled override risk where a
maliciously crafted payment payload could trick AntFleet into
attributing the call to a different wallet.

Add a test asserting that a payload with `authorization.from = A` but
`signer = B` (extra field) returns `A` (canonical path), not `B`.

**P2.11 — Document FR-C3 middleware framing (QUESTION #2)**

Location: `specs/SPEC-001-aeon-x402.md` FR-C3.

Spec says "single middleware whose removal does not require touching
the endpoint handler." Current implementation is an inline function
call (`requireAeonContext()`) at the top of the route handler,
toggled by `X402_REQUIRE_AEON_CONTEXT`.

Add a clarifying paragraph to FR-C3:

> "In v1 the gate is implemented as a top-of-handler function call
> (`requireAeonContext()` at `apps/web/app/api/v1/review/x402/route.ts:126`)
> rather than a Next.js middleware. This satisfies the spirit of FR-C3
> (the env flag `X402_REQUIRE_AEON_CONTEXT=false` removes the gate
> without code change in handlers, pipeline, worker, or receipt
> rendering) but is technically not a Next.js middleware. v2 may
> migrate to a true `apps/web/middleware.ts` entry if multiple x402
> endpoints emerge that share the gate."

Document in v0.5 change log.

**P2.12 — Defend against cross-rail review_id collision (QUESTION #4)**

Location: `apps/web/db/queries.ts:1155` (the receipt query touched in
P0.5).

After the P0.5 fix makes the query rail-agnostic, a future change
that shares `review_id` across rails could cause non-deterministic
resolution. Defend by:
- Adding an explicit `ORDER BY j.created_at DESC` to the GROUP BY +
  LIMIT 1 query (newest wins).
- Or: enforce uniqueness at the DB level — `review_id` is already
  UNIQUE per review, so cross-rail collision should be impossible.
  Verify by checking the `reviews` table schema.

Document the resolution in implementation notes.

**P2.13 — Confirm + update skills-pack.json bump (QUESTION #5)**

Per audit: FR-B1 diagram implies but spec body doesn't enumerate
the `skills-pack.json` field at `antfleet/aeon-skills`. Read the
current `skills-pack.json` shape, patch spec § 5.4 to include the
exact field-by-field diff, AND apply that bump in the Part B PR
(P3.1).

**P2.14 — Spec v0.5 change log**

Add `**Change log v0.5:**` block at the top of
`specs/SPEC-001-aeon-x402.md` listing every spec edit from P0.4,
P0.5, P1.6 (if spec updated), P2.8, P2.11, P2.12, P2.13. Bump version
line to `v0.5 (<today>, impl audit closing)`.

---

### P3 — Part B (cross-repo PRs — CRITICAL launch blocker)

These two PRs land on EXTERNAL repos. Use `gh` CLI; `antfleet-ops`
account is already authenticated.

**P3.1 — `antfleet/aeon-skills :: pr-review-antfleet-x402/` folder PR**

```bash
cd /tmp && rm -rf aeon-skills-part-b
gh repo clone antfleet/aeon-skills /tmp/aeon-skills-part-b
cd /tmp/aeon-skills-part-b
git checkout -b feat/pr-review-antfleet-x402
mkdir pr-review-antfleet-x402
```

Inside `pr-review-antfleet-x402/`, create (mirror the structure of
the existing `pr-review-antfleet/`):

**SKILL.md** — frontmatter per spec FR-B2:

```yaml
---
name: AntFleet PR review (x402)
description: Pull-mode two-model-consensus PR review via x402. Pay-per-call USDC on Base, no AntFleet installation required. Public repos only. v1 access restricted to aeon-ecosystem callers.
var: "TARGET"
tags: [dev, code-review, antfleet, base, x402, public]
---
```

Body documents (mirror existing `pr-review-antfleet/SKILL.md` shape):
- Required env vars: `AEON_X402_WALLET_PRIVATE_KEY`, `AEON_CONTEXT_TOKEN`
- Optional env vars: `ANTFLEET_API_BASE` (default `https://www.antfleet.dev`),
  `ANTFLEET_OUTPUT_PATH` (default `.outputs/pr-review-antfleet-x402.md`),
  `ALERT_CHANNEL` (optional)
- NOT required (intentional distinction from v2 channel skill):
  `ANTFLEET_INSTALLATION_ID`, `ANTFLEET_WALLET_PRIVATE_KEY`
- Exit codes: 0 success, 2 permanent failure, 3 transient
- Per FR-B3: runner sets EIP-3009 `validAfter=now`, `validBefore=now+600s`
- Per FR-B4: output uses `**Paid via:** x402` header, review-level
  receipt URL, no `**PR comment:**` line

**run.mjs** — x402 client implementation. Mirror the existing
`pr-review-antfleet/run.mjs` structure but:
- Replace channel-rail wallet-binding + installation auth with x402
  client construction
- Use `@x402/core` + `@x402/evm` to construct EIP-3009 authorization
  with 600s window
- Submit to `${ANTFLEET_API_BASE}/api/v1/review/x402` with
  `X-Aeon-Context` header from env
- Poll `${ANTFLEET_API_BASE}/api/v1/review/x402/{jobId}` every 10s
  for up to 10 minutes
- Write output to `${ANTFLEET_OUTPUT_PATH:-.outputs/pr-review-antfleet-x402.md}`
- Fire `./notify` if `ALERT_CHANNEL` set and finding has critical/high severity

**package.json** — declare deps:
```json
{
  "name": "pr-review-antfleet-x402",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@x402/core": "<pinned-version>",
    "@x402/evm": "<pinned-version>",
    "viem": "<pinned-version>"
  }
}
```

Pin specific versions after verifying on npm registry.

**`.outputs/pr-review-antfleet-x402.md` template** — optional; if the
existing skill has a template, mirror it.

**Update `skills-pack.json` at the pack root**:
```json
{
  "name": "AntFleet PR Review",
  "version": "2.1",
  "skills": [
    {"slug": "pr-review-antfleet", "path": "pr-review-antfleet", "category": "review", "default_enabled": false},
    {"slug": "pr-review-antfleet-x402", "path": "pr-review-antfleet-x402", "category": "review", "default_enabled": false}
  ]
}
```

(Read current shape FIRST per P2.13; adapt to actual schema.)

Open PR:

```bash
gh auth switch -u antfleet-ops
git add pr-review-antfleet-x402/ skills-pack.json
git commit -m "feat: add pr-review-antfleet-x402 skill for x402 pay-per-call reviews

Implements SPEC-001 v0.5 Part B (FR-B1-B4): an x402 variant of the
PR review skill that pays per call via USDC on Base, requiring no
AntFleet installation. v1 access restricted to aeon-ecosystem
callers (X-Aeon-Context header required).

Mirrors the existing pr-review-antfleet skill structure with x402
authentication and stateless wallet-as-identity flow.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git push -u origin feat/pr-review-antfleet-x402
gh pr create --title "feat: add pr-review-antfleet-x402 skill" --body "..."
```

PR body should reference SPEC-001 v0.5 and link the relevant FRs.

**P3.2 — `aaronjmars/aeon :: skill-packs.json` one-line registry PR**

After P3.1 merges (or in parallel):

```bash
cd /tmp && rm -rf aeon-registry-pr
gh repo clone aaronjmars/aeon /tmp/aeon-registry-pr
cd /tmp/aeon-registry-pr
git checkout -b antfleet-x402-skill-registry
```

Apply the one-line diff per spec § 5.4. The existing AntFleet entry
at `skill-packs.json` has:

```json
{
  "repo": "AntFleet/aeon-skills",
  "name": "AntFleet aeon-skills",
  "description": "<existing>",
  ...
  "skills": ["pr-review-antfleet"]
}
```

Change to:
```json
{
  "repo": "AntFleet/aeon-skills",
  "name": "AntFleet aeon-skills",
  "description": "On-demand two-model-consensus PR review with on-chain USDC payment on Base. Channel-rail variant for installed repos; x402-rail variant for public repos with pay-per-call USDC (v1 restricted to aeon-ecosystem callers).",
  ...
  "skills": ["pr-review-antfleet", "pr-review-antfleet-x402"]
}
```

Also update `docs/community-skill-packs.md` row to mention x402
variant.

Commit + push + open PR:

```bash
git add skill-packs.json docs/community-skill-packs.md
git commit -m "docs(skill-packs): add pr-review-antfleet-x402 to AntFleet entry

Adds the x402 pay-per-call PR review skill variant to AntFleet's
registry entry. AntFleet is already trust_level: trusted (PR #211),
so no new tier review is required.

Skill source: github.com/antfleet/aeon-skills/tree/main/pr-review-antfleet-x402
SPEC reference: SPEC-001 v0.5 § 5.4

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

git push -u origin antfleet-x402-skill-registry
gh pr create --title "docs(skill-packs): add pr-review-antfleet-x402 to AntFleet entry" --body "..."
```

PR body references SPEC-001 v0.5 + the trusted-tier precedent +
links to the skill source.

---

## Process

1. Read the required materials above (full audit, spec v0.4, key code
   files).

2. Apply P0.1 → P0.6 (must land before mainnet). Run
   `pnpm --dir apps/web test` after each P0 fix to catch regressions
   early. Channel-rail tests MUST stay green throughout.

3. Apply P1.1 → P1.7 (test gap closures + copy fixes). Run full test
   suite at end of P1.

4. Apply P2.1 → P2.14 (polish + spec edits + question closures).

5. Apply P3.1 → P3.2 (cross-repo Part B).

6. Self-review pass:
   - All 3 invariants still PRESERVED (FR-E1, FR-C3, AC-7)?
   - Full `apps/web` test suite green?
   - Typecheck green?
   - Spec v0.5 change log references every spec edit?
   - Implementation notes updated with deviations + decisions?

7. Print a 400-word handback summary to stdout listing:
   - Findings closed by priority (P0/P1/P2/P3 counts)
   - Test pass status (channel-rail tests, x402 tests, total counts)
   - Spec v0.5 ship status (committed locally? PR opened?)
   - Part B PR status (P3.1 + P3.2 URLs if opened)
   - Any deviations from defaults (especially if a baked-in default
     proved impossible)
   - Operator decisions still needed (OQ-1 secret distribution,
     OQ-5 CDP keys, AC-1 mainnet operator gating)
   - Lines of code added/modified (rough)
   - Recommendation: proceed to mainnet AC-1 / hold for operator
     decisions / hold for fix

8. Do NOT commit P0+P1+P2 code changes yourself — operator commits
   them as logical groupings. EXCEPTION: P3 cross-repo PRs (P3.1 +
   P3.2) MUST be committed + pushed + opened as PRs by you, since
   they're on external repos and the operator can't easily review
   uncommitted external-repo work.

## What NOT to do

- Do NOT modify `apps/web/lib/review-pipeline.ts` (FR-E1 invariant
  — pipeline is byte-frozen).
- Do NOT add new `if (paymentRail === 'x402')` branching anywhere in
  the pipeline.
- Do NOT pick a different default for FR-A2 or receipt query drift
  silently. If a default is impossible, stop + document.
- Do NOT skip Part B (P3) — it's the launch blocker.
- Do NOT use `--no-verify` on any commit.
- Do NOT use `git add -A` or `git add .` — stage files explicitly.
- Do NOT switch git config or alter commit identity.
- Do NOT use `Augustas11` gh account for any antfleet/* or
  aaronjmars/aeon write op. Always `antfleet-ops`.
- Do NOT commit `apps/web/` changes yourself — operator commits.

## Expected size of diff

| Area | Files | LOC estimate |
|---|---|---|
| P0.1-P0.6 code fixes | ~8 files modified | ~250 LOC changes |
| P0 spec edits (FR-A2 rewrite, change log) | 1 spec file | ~100 LOC |
| P1.1-P1.7 new tests + copy fixes | ~6 new test files, ~2 modified | ~600 LOC new |
| P2 polish | ~8 files modified, ~2 new | ~300 LOC mixed |
| P2 spec edits (FR-E3, FR-C3, change log) | 1 spec file | ~50 LOC additions |
| P3.1 antfleet/aeon-skills PR | ~4 new files | ~250 LOC new |
| P3.2 aaronjmars/aeon PR | 2 files modified | ~10 LOC |
| Implementation notes update | 1 file | ~30 LOC |

**Total in this repo:** ~1300 LOC mixed.
**Total in external repos:** ~260 LOC across 2 PRs.

If P0+P1+P2 diff in this repo exceeds ~1800 LOC, you've likely
introduced scope creep beyond the 31 findings. Stop + audit your
changes against the audit report.

When done, print the 400-word handback summary and stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist (per priority group):

**After P0 (~2 hours of work):**
- [ ] Channel-rail tests still pass (107 across 18 files)
- [ ] x402 tests pass (route.test.ts, x402/*.test.ts, worker.x402.test.ts)
- [ ] FR-D3 timeout test added + green
- [ ] FR-D1 ordering test added + green
- [ ] PAYMENT-RESPONSE header test added + green
- [ ] Receipt query test for channel-rail review added + green
- [ ] Spec v0.5 committed locally with FR-A2 rewrite + change log

**After P1 (~2 hours of work):**
- [ ] AC-3, AC-6, AC-10, AC-11, AC-12 tests all green
- [ ] Migration test now does real apply (not string grep)
- [ ] AC-12 page tests render all three seed-row shapes correctly
- [ ] Mainnet facilitator URL is canonical (spec & code agree)

**After P2 (~1-2 hours of work):**
- [ ] All 14 MINOR + 5 QUESTION items addressed
- [ ] Spec v0.5 change log lists every edit
- [ ] Implementation notes capture all design decisions

**After P3 (~2-3 hours of work, mostly waiting on PR review):**
- [ ] `antfleet/aeon-skills` PR opened (P3.1 URL)
- [ ] `aaronjmars/aeon` PR opened (P3.2 URL)
- [ ] PRs include SPEC-001 v0.5 references in body

Commit suggestions (operator runs after fix lands):

```bash
# P0 batch
git add apps/web/lib/review-job-worker.ts apps/web/lib/review-job-worker.x402.test.ts
git commit -m "x402: implement FR-D3 Layer 1 600s wall-clock timeout (impl audit P0.1)"

git add apps/web/app/api/v1/review/x402/route.ts apps/web/app/api/v1/review/x402/route.test.ts apps/web/lib/x402/facilitator.ts
git commit -m "x402: reorder rate-limit + cooldown BEFORE verifyPayment per FR-D1 (impl audit P0.2)"

# ... continue per-fix or per-priority-group
```

## Total expected timeline

- P0+P1 in one pass: ~4 hours
- P2 in a follow-up: ~2 hours
- P3 PRs opened: same day as P2 (with merge depending on Aaron's
  review timing for P3.2)

**Critical path to launch:** P0 + P3 complete + Aaron merges P3.2 + operator provisions CDP keys (OQ-5) + Aaron confirms HMAC secret (OQ-1). Then mainnet AC-1 can run.

Target ship: 2026-06-03 if Aaron's registry merge is quick.
