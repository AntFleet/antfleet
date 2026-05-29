# Fix prompt — SPEC-001 v0.2 round-2 audit findings → v0.3

Operator-paste prompt to apply the round-2 audit findings from
`specs/SPEC-001-v0-2-audit.md` (Claude Opus 4.7, 2026-05-29).

The round-2 audit closed 17/18 round-1 findings cleanly. The remaining
issues are narrow:

  1 CRITICAL — Migration 0028 CHECK constraint omits production literal
               `insufficient_channel_balance` (channel-rail regression)
  4 MAJOR    — Treasury env var contract; testnet/mainnet routing env layer;
               EIP-3009 validity window enforcement; test infrastructure FRs
  3 MINOR    — Change-log sub-bullet, AC-7 file enumeration, § 7 heading
  1 QUESTION — Package version pinning (process-gated, no action)

The single CRITICAL is a one-block SQL change. The 4 MAJORs are local
clarity additions (~80-150 spec lines total per auditor estimate).
After this fix, **narrow re-audit** (only the changed sections) is
justified — the new CRITICAL is not structural and the other findings
are local.

Operator decisions baked in as defaults:

| # | Decision | Default | Source |
|---|---|---|---|
| 1 | C2-1 fix mechanism | Drop CHECK constraint entirely; gate at application layer per existing pattern | Auditor recommendation |
| 2 | Treasury wallet (C2-2) | Same hot wallet as channel `ANTFLEET_DEPOSIT_ADDRESS`; 5xx with `code: 'treasury_unconfigured'` on missing | Operational simplicity |
| 3 | Sepolia USDC asset (C2-3) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Circle official Sepolia USDC) | Public Circle docs |
| 4 | EIP-3009 validity window (C2-4) | Skill sets 600s; server hard ceiling 900s; reject if `validBefore - now > 900` | Matches existing 600s job timeout |
| 5 | Test infrastructure (C2-5) | Commit to building all four artifacts as in-scope deliverables | Per audit recommendation |

Version bumps:
  SPEC-001 v0.2 → v0.3

Run in **Claude Code** OR **Codex CLI** (fix application doesn't need
cross-model; the fixes are prescriptive). Expected duration: ~30-45 min
(much shorter than v0.2 fix; narrow surgical edits).

Paste everything between `=== BEGIN PROMPT ===` and `=== END PROMPT ===`
into a fresh session rooted at `/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are applying round-2 audit fixes to SPEC-001 (Aeon x402 pull-mode
review skill). The audit report at specs/SPEC-001-v0-2-audit.md returned
verdict NEEDS REVISION with 1 CRITICAL + 4 MAJOR + 3 MINOR + 1 QUESTION
findings.

The previous fix pass (v0.1 → v0.2) closed 17 of 18 round-1 findings
cleanly. This pass closes the remaining narrow set, including one new
CRITICAL introduced when the v0.2 C-2 fix locked in a SQL CHECK that
omits a production literal.

You will edit one file in place and bump its version:
  /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md  v0.2 → v0.3

You will NOT modify any production source code, migrations, other spec
documents, or skill-pack source. This is a spec-only patch.

## Critical constraints

**1. Dual-rail isolation invariant — extra scrutiny.** The round-2
CRITICAL (C2-1) is a channel-rail regression introduced by the v0.2
fix. Your fix MUST NOT introduce any new channel-rail regression. When
in doubt, prefer the smaller, less-coupled change.

**2. Aeon-gate removability invariant.** Unchanged in this pass; do not
modify FR-C3.

**3. v1 scope discipline.** § 2.2 OOS list is unchanged. The MAJORs in
this pass are local clarity additions that do NOT expand scope; if a
fix tempts you toward Bankr/sybil/adversarial/private-via-x402/PR-
comments territory, stop.

**4. Surgical scope per fix.** Each fix below is fully specified. Apply
exactly what's described. The auditor estimated 80-150 spec lines total;
treat that as a soft ceiling. Drift beyond ~200 lines is itself a
scope-creep failure mode requiring re-audit.

**5. Source code is authoritative.** Fix C2-1 explicitly cites
production code that uses `insufficient_channel_balance`. Verify by
grep before finalizing the SQL change.

## Required reading (in order)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-v0-2-audit.md
   — read fully, especially the "Suggested fix order" section and the
   detailed CRITICAL (C2-1) finding.

2. /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md (v0.2)
   — the spec being edited. Read § 5.3 (migration SQL), FR-A2 (x402
   payload), FR-A4 (mainnet-only clause), FR-A9 (defer-settle),
   FR-B3 (skill runner), § 8 ACs, § 7 phase-findings placeholder.

3. /Users/augstar/projects/antfleet/apps/web/app/api/v1/installations/[id]/review/route.ts
   — AUTHORITATIVE source for C2-1. Grep for `insufficient_channel_balance`
   to confirm it's a real production literal at the cited line ranges.

4. /Users/augstar/projects/antfleet/apps/web/lib/paywall/refund.ts
   — AUTHORITATIVE source for `REFUNDABLE_FAILURE_MODES` enum (cited
   in FR-A8 commentary).

5. /Users/augstar/projects/antfleet/apps/web/db/migrations/0024_review_jobs.sql
   /Users/augstar/projects/antfleet/apps/web/db/migrations/0027_review_jobs_billing_pending.sql
   — confirm there is NO existing CHECK constraint on `failure_mode`
   (justifies dropping rather than expanding it).

6. Final cross-check: grep `apps/web/` for ALL `failure_mode` string
   literals to ensure no other production-only values exist that the
   spec should document:
     grep -rn "failure_mode" apps/web/app apps/web/lib | grep -iE "'[a-z_]+'" | sort -u
   Note any literals beyond {provider_error, timeout, internal,
   user_input, validation, cost_cap_exceeded, insufficient_channel_balance}.
   If you find others, document them in FR-A8 as channel-rail-only
   alongside `insufficient_channel_balance`.

## Operator decisions baked in as defaults

| # | Decision | Default |
|---|---|---|
| 1 | C2-1 mechanism | **Drop CHECK constraint entirely** (don't expand the allow-list). Production code gates at the application layer; DB-level CHECK introduces unnecessary coupling. |
| 2 | C2-2 treasury wallet | **Same hot wallet as channel `ANTFLEET_DEPOSIT_ADDRESS`** by default (configurable). 5xx with `code: 'treasury_unconfigured'` on missing. EIP-55 checksummed format required. |
| 3 | C2-3 Sepolia USDC asset | **`0x036CbD53842c5426634e7929541eC2318f3dCF7e`** (Circle's official Sepolia USDC). |
| 4 | C2-4 validity window | **Skill sets 600s window; server enforces 900s hard ceiling.** |
| 5 | C2-5 test infrastructure | **Commit to building all four artifacts as in-scope v1 deliverables.** Add to § 11 Build steps. |

If during application any default proves impossible (e.g. the cited
production literal turns out NOT to exist when you grep), STOP and
document in the handback summary. Do NOT pick a different default
silently.

## Fixes to apply

Apply in section order: header → § 5.3 → § 4 Part A → § 4 Part B →
§ 4 Part E → § 5.5 (new) → § 7 → § 8 → § 11.

### Fix CHG-LOG. Add v0.3 change-log entry to header

**Location:** SPEC-001 header (after "Change log v0.2").

**Action:**
1. Add a `**Change log v0.3:**` block listing every fix applied. Format
   matches the v0.2 entry style.
2. Bump `**Version:**` from `0.2 (...)` to `0.3 (<today's date>, round-2 audit closing)`.

The change-log v0.3 entry MUST reference every audit finding ID
addressed (C2-1, C2-2, C2-3, C2-4, C2-5, C2-6, C2-7, C2-8).

### Fix C2-1 (CRITICAL). Drop migration 0028 CHECK constraint

**Audit finding:** C2-1 — Migration 0028 CHECK constraint omits
`insufficient_channel_balance` (production literal at
`route.ts:323/398/404`). Either fails to apply or breaks channel-rail
billing.

**Default applied:** Drop the CHECK constraint entirely. Production
code already gates `failure_mode` values at the application layer via
`refund.ts REFUNDABLE_FAILURE_MODES`. DB-level CHECK adds coupling
without safety.

**§ 5.3 SQL block changes:**

Replace the current ALTER TABLE block (containing the
`review_jobs_failure_mode_check` constraint) with the minimal SQL that
FR-E3 actually requires:

```sql
-- Migration 0028: x402-rail support for review_jobs
--
-- Adds the two columns x402 jobs need (caller_wallet + payment_rail)
-- plus indexes for lookup/listing. Does NOT add a CHECK constraint on
-- failure_mode; the production channel rail writes additional literals
-- (e.g. 'insufficient_channel_balance') that are gated at the
-- application layer via apps/web/lib/paywall/refund.ts. Adding a
-- DB-level CHECK would couple every future failure_mode addition to a
-- schema migration, which is operationally undesirable.

ALTER TABLE review_jobs
  ADD COLUMN caller_wallet text,
  ADD COLUMN payment_rail text NOT NULL DEFAULT 'channel'
    CHECK (payment_rail IN ('channel','x402'));

-- Backfill (idempotent; default covers new rows but make existing rows explicit)
UPDATE review_jobs SET payment_rail = 'channel' WHERE payment_rail IS NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_caller_wallet
  ON review_jobs (caller_wallet)
  WHERE caller_wallet IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_payment_rail_created
  ON review_jobs (payment_rail, created_at DESC);
```

**FR-A8 commentary additions:**

After the terminal-states table in FR-A8, add a paragraph:

> **Channel-rail-only failure_mode values.** The production channel rail
> writes additional `failure_mode` values not used by the x402 rail —
> notably `insufficient_channel_balance` (when a wallet-bound channel
> lacks funds at billing time, written by
> `apps/web/app/api/v1/installations/[id]/review/route.ts`). These
> values are valid on the shared `review_jobs.failure_mode` column but
> are out of scope for x402-rail terminal-state semantics (a funded
> x402 caller cannot enter an insufficient-balance state because
> payment is verified pre-enqueue per FR-A9 step 1). Migration 0028
> deliberately does NOT add a CHECK constraint on `failure_mode`
> because application-layer gating in `apps/web/lib/paywall/refund.ts`
> already enforces the refund-eligible set.

(If your `grep -rn "failure_mode"` cross-check from the required-reading
step surfaced any other production-only literals beyond
`insufficient_channel_balance`, list them in this paragraph too.)

**AC-11 update:**

Update the AC-11 "Expected" list to remove any clause that asserts a
CHECK constraint on `failure_mode`. Replace step 4 from:

> "4. `failure_mode` enum includes `cost_cap_exceeded` (this enum addition is part of migration 0028 per fix C-2)."

with:

> "4. `failure_mode` column remains a `text` column with no CHECK constraint (application-layer gating only, per FR-A8 commentary). Verify no `review_jobs_failure_mode_check` constraint exists post-migration."

### Fix C2-2 (MAJOR). Define `ANTFLEET_X402_TREASURY` env var contract

**Audit finding:** C2-2 — env var referenced once with no ownership,
format, fallback, or settle-address-must-match-advertised invariant.

**Default applied:** Same hot wallet as channel `ANTFLEET_DEPOSIT_ADDRESS`
by default; 5xx with `code: 'treasury_unconfigured'` if unset.

**Add new FR-A4b after FR-A4:**

```
**FR-A4b. Treasury address handling.**

The `payTo` value in the FR-A2 402-response payload is read from the
env var `ANTFLEET_X402_TREASURY` at request time.

**Format.** EIP-55 checksummed address (mixed-case). The endpoint MUST
reject malformed values at startup (process exits with a clear error)
or, if the env var changes at runtime, at request time with HTTP 500
and `code: 'treasury_unconfigured'`. No fallback to a hard-coded
address; misconfiguration is fail-closed.

**Ownership and custody.** The address SHOULD be the same hot wallet
used by the channel rail (`ANTFLEET_DEPOSIT_ADDRESS` per existing
deployment) unless the operator explicitly wants separate treasuries
for the two rails. Using the same wallet simplifies reconciliation
and reduces operational surface. A separate dedicated x402 treasury
is permitted but not required in v1.

**Settle-address pinning.** The `/settle` call's destination MUST be
identical to the address advertised in the 402 response's `payTo`
field. The worker MUST refuse to call `/settle` against any address
that differs from the originally advertised one (defends against
runtime env-var mutation between 402 negotiation and post-review
settlement). Implementation: persist the advertised `payTo` in the
`review_jobs` row at enqueue time; settlement reads from the row,
not from the live env var.

**Missing-env behavior.** If `ANTFLEET_X402_TREASURY` is unset at
request time, the endpoint MUST return HTTP 500 with body
`{"error": {"code": "treasury_unconfigured", "message": "x402 treasury address not configured"}}`.
No x402 negotiation is attempted; no rate-limit budget is consumed.

**Configuration verification.** Startup health check
(`/api/v1/health` or equivalent) MUST verify `ANTFLEET_X402_TREASURY`
is set and well-formed. The verification result is visible to
operators via the existing health endpoint.
```

**§ 5.3 review_jobs additions:**

Add to the migration 0028 SQL block a new column to persist the
advertised payTo:

```sql
ALTER TABLE review_jobs
  ADD COLUMN x402_pay_to text;  -- nullable; populated only for x402 jobs

CREATE INDEX IF NOT EXISTS idx_review_jobs_x402_pay_to
  ON review_jobs (x402_pay_to)
  WHERE x402_pay_to IS NOT NULL;
```

Document the column in the migration's leading SQL comment.

### Fix C2-3 (MAJOR). Add testnet/mainnet routing env vars

**Audit finding:** C2-3 — FR-A2 hardcodes mainnet network/asset; AC-1a
needs Sepolia; no env-var layer defined.

**Default applied:** Add `X402_NETWORK`, `X402_USDC_ASSET`,
`X402_FACILITATOR` env vars. Use Circle's official Sepolia USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`).

**FR-A2 changes:**

Replace the hardcoded values in the example payload with placeholder
references:

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

Add a paragraph after the example:

> The `network`, `asset`, and `payTo` fields are produced from
> environment variables at request time per FR-A4 (network/asset) and
> FR-A4b (treasury). Production mainnet defaults are pinned in FR-A4;
> staging substitutes Sepolia values per FR-A4.

**FR-A4 full rewrite:**

```
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
```

**§ 5.1 endpoint contract table changes:**

Add three new rows for the env vars:

| Property | Value |
|---|---|
| Env: `X402_NETWORK` | CAIP-2 string; production `eip155:8453`, staging `eip155:84532` |
| Env: `X402_USDC_ASSET` | EVM address; matched to `X402_NETWORK` |
| Env: `X402_FACILITATOR` | Facilitator base URL; CDP for mainnet, x402.org for testnet |

### Fix C2-4 (MAJOR). Enforce EIP-3009 validity window

**Audit finding:** C2-4 — "10 minutes by skill runner" asserted in
FR-A9 but never enforced (FR-B3 doesn't set it; no server-side ceiling).
Refund-via-expiry depends on actual expiry.

**Default applied:** Skill sets `validBefore = now + 600s`; server
enforces hard ceiling of 900s; reject if `validBefore - now > 900`
at /verify time.

**FR-A9 changes:**

Remove the parenthetical "set to ~10 minutes by the skill runner" from
FR-A9 step 2. Replace with: "The signed authorization bounds are
enforced per FR-B3 (skill-side) and FR-A2/FR-A4c (server-side); see
those FRs for the contract."

**Add new FR-A4c after FR-A4b:**

```
**FR-A4c. EIP-3009 authorization window enforcement.**

The defer-settle refund mechanism (FR-A9) is load-bearing on payment
authorizations actually expiring before any post-terminal `/settle`
call could be issued. This FR enforces the window at both ends.

**Server-side hard ceiling.** At /verify time the endpoint MUST reject
any payment authorization whose window exceeds 900 seconds
(`validBefore - now > 900`). Rejection returns HTTP 400 with body
`{"error": {"code": "x402_authorization_window_too_long", "message": "Authorization validBefore - now exceeds 900s; skill must set validBefore = now + 600s"}}`.

**Server-side past-time rejection.** At /verify time the endpoint MUST
also reject any authorization whose `validBefore <= now` (already expired)
with code `x402_authorization_expired`, and any whose `validAfter > now + 30`
(starts too far in the future — matches the 30s clock-skew tolerance from
FR-C2) with code `x402_authorization_not_yet_valid`.

**Persisted authorization.** On /verify success, the worker persists
the verified `(validAfter, validBefore, payment_payload)` to the
`review_jobs` row. Post-terminal `/settle` reads from the row and
MUST refuse to call `/settle` if the persisted `validBefore` has
already elapsed (`now > validBefore`). This is defense-in-depth in
case the worker drains slowly or the operator triggers a manual settle.

**Rationale.** The 900s ceiling provides headroom over the worker's
600s wall-clock timeout (FR-D3) so even a job that ran the full 600s
plus brief settlement latency is within window. Allowing skills to mint
multi-hour authorizations would make defer-settle a guarantee of
expiry-in-theory rather than expiry-in-practice.
```

**FR-B3 changes:**

Add a new explicit step to the skill runner contract. After step 2
(constructs x402 client), insert:

> "2a. The runner MUST construct the EIP-3009 authorization with
> `validAfter = now` and `validBefore = now + 600s`. This is below the
> server-side 900s ceiling (FR-A4c) and provides a 5-minute safety
> margin above the 600s job timeout (FR-D3). Skills that mint longer
> windows MUST be rejected by the server per FR-A4c; this client-side
> setting is the primary control."

**AC-4 extension:**

Add to AC-4 "Expected" list as new step 5:

> "5. Authorization persistence: the `review_jobs` row for the failed
> job contains the persisted `validBefore` value; `validBefore - completed_at < 900s`
> demonstrating the window was within ceiling. The persisted
> authorization is not referenced again post-terminal (no `/settle`
> call ever issued for this row)."

### Fix C2-5 (MAJOR). Commit to test infrastructure deliverables

**Audit finding:** C2-5 — AC-1a/AC-10/AC-11/AC-12 require artifacts no
FR commits AntFleet to building (fixture repo, fixture PR, migration
apply script, AC-12 seed rows).

**Default applied:** Add § 5.5 enumerating these as in-scope
deliverables. Add to § 11 Build steps.

**Add new § 5.5 after § 5.4:**

```
## 5.5. Test infrastructure dependencies

The acceptance criteria in § 8 depend on four test artifacts that this
spec commits AntFleet to producing as part of the v1 implementation.
Each is required for the corresponding AC to be runnable.

### 5.5.1 Fixture repo: `antfleet/x402-fixture`

**Purpose:** Public GitHub repo used as the target for AC-1, AC-1a,
and AC-10 end-to-end runs.

**Contract:**
- Public repository at `https://github.com/antfleet/x402-fixture`.
- Contains a deliberately minimal source tree (a few TypeScript files)
  and a stable canonical PR #1 with a known small diff (~50 lines)
  for happy-path testing.
- A second PR (#2) with the AC-10 forced-large-diff fixture (~50K
  lines changed; documented in the repo's README as test-only).
- No production code; the repo exists solely as a stable target for
  AntFleet test runs.
- Repo creator: AntFleet org. Owner: `antfleet-ops` (per project
  account conventions).

**Stability:** PR #1 head SHA MUST remain stable across runs (no
rebases, force-pushes, or new commits). Changes to the fixture require
a spec patch + AC rev.

### 5.5.2 Migration apply script: `apply-migration-0028.ts`

**Purpose:** AC-11 references `apply-migration-0028.ts --apply` per
project convention (project memory: "migrations need manual apply via
`apply-migration-XXXX.ts --apply`").

**Contract:**
- Located at `apps/web/db/migrations/apply-migration-0028.ts`.
- `--apply` flag is required to perform writes; bare invocation does
  dry-run printing of the SQL.
- Idempotent: re-running after successful apply is a no-op.
- Reports caller_wallet, payment_rail, and x402_pay_to column
  presence and the absence of `review_jobs_failure_mode_check` after
  successful apply.

### 5.5.3 AC-12 seed rows

**Purpose:** AC-12 needs three reviewable review_jobs rows in the
staging DB.

**Contract:**
- Three rows seeded into staging via
  `apps/web/db/seed/x402-receipt-test-fixtures.ts` (new file).
- Row 1: `status=complete`, payment_rail=x402, 2 associated findings.
- Row 2: `status=complete`, payment_rail=x402, 0 findings.
- Row 3: `status=failed`, payment_rail=x402,
  `failure_mode=provider_error`, 0 findings.
- All three reference the AC-1 fixture repo PR #1 head SHA for
  consistency.

### 5.5.4 Review-level receipt page

**Purpose:** AC-12 requires the new review-level surface
(`/receipts/review/{review_id}`) per FR-E2.

**Contract:**
- Page implemented at `apps/web/app/receipts/review/[id]/page.tsx`.
- Renders the contents specified in FR-E2.
- Public (no auth required for review-level read).
- The existing finding-level `/receipts/{id}` page at
  `apps/web/app/receipts/[id]/page.tsx` is unchanged.

### Build-order coupling

These four artifacts gate the corresponding ACs:
- 5.5.1 fixture repo → AC-1, AC-1a, AC-10
- 5.5.2 migration script → AC-11
- 5.5.3 seed rows → AC-12
- 5.5.4 receipt page → AC-12

They are added to § 11 Build steps as numbered items.
```

**§ 11 Build steps additions:**

Insert between current steps 1 (Migration) and 2 (x402 endpoint):

> "1a. **Build-prereq: create the fixture repo + seed rows.** Per § 5.5,
> create `antfleet/x402-fixture` (public, PR #1 happy path, PR #2 large
> diff). Write the seed-rows script at
> `apps/web/db/seed/x402-receipt-test-fixtures.ts`. These deliverables
> can be done in parallel with step 1 (migration)."

Insert as new step 7 (after current step 6 registry PR):

> "7. **Build-postreq: AC infrastructure.** Verify all § 5.5 artifacts
> are in place. AC-1, AC-1a, AC-10, AC-11, AC-12 each gate on a § 5.5
> artifact; build is not complete until all run green."

### Fix C2-6 (MINOR). Change-log sub-bullet for x402 receipt URL behavior

**Audit finding:** C2-6 — change log v0.2 M-7 entry doesn't surface
that x402 job terminal payloads use review-level URL by default.

**Location:** Change log v0.2 entry under M-7.

**Action:** Add a sub-bullet under the existing M-7 line:

> "  - x402 job terminal-state payloads include the review-level URL (`/receipts/review/{review_id}`) by default, not finding-level."

### Fix C2-7 (MINOR). Enumerate AC-7 channel-rail test set

**Audit finding:** C2-7 — AC-7 says "tests pass without modification"
with "etc." trailing; doesn't enumerate the gate set.

**Location:** AC-7 "How to verify" line.

**Action:** Replace the line:

> "Existing channel-rail integration tests (route.test.ts, review-worker.test.ts, etc.) pass without modification."

with:

> "All existing channel-rail tests pass without modification. The gate set is `apps/web/**/*.test.ts` excluding any new `apps/web/lib/x402/**` and `apps/web/app/api/v1/review/x402/**` paths. Specifically: `apps/web/app/api/v1/installations/[id]/review/route.test.ts`, `apps/web/app/api/v1/installations/[id]/review/[jobId]/route.test.ts`, `apps/web/lib/review-worker.test.ts`, `apps/web/lib/paywall/*.test.ts`, plus any other channel-rail tests present at v0.3 spec lock."

### Fix C2-8 (MINOR). § 7 heading + body update

**Audit finding:** C2-8 — § 7 still says "SPEC-001 v0.1" after v0.2/v0.3
bumps; "no prior findings to encode" is stale.

**Location:** § 7 heading and body.

**Action:** Rename § 7 heading from
"## 7. Phase findings encoded in SPEC-001 v0.1"
to
"## 7. Audit findings encoded in this spec"

Replace the body with a brief summary of round-1 and round-2 closures:

> "This section tracks audit findings from prior revisions that are
> now encoded in normative requirements above. Per the macprovider
> spec discipline this spec was patterned after, findings are not
> just fixed — their resolutions are documented here so future
> readers understand why specific clauses exist.
>
> **Round-1 audit (v0.1, Codex GPT-5, 2026-05-28):** 2 CRITICAL +
> 9 MAJOR + 3 MINOR + 4 QUESTION. All 18 findings addressed in v0.2.
> Notable resolutions: terminal-state taxonomy aligned with
> `apps/web/lib/paywall/refund.ts` (FR-A8); x402 v2 protocol adopted
> end-to-end (FR-A2); verify-then-defer-settle replaces fictional
> `/void` (FR-A9); review-level receipt surface carved out
> separately from finding-level (FR-E2); aeon-gate gained `kid` +
> clock skew + 24h rotation (FR-C2).
>
> **Round-2 audit (v0.2, Claude Opus 4.7, 2026-05-29):** 1 CRITICAL
> + 4 MAJOR + 3 MINOR + 1 QUESTION. All 9 findings addressed in v0.3.
> Notable resolutions: migration 0028 CHECK constraint dropped to
> avoid channel-rail regression (FR-A8 commentary); treasury env var
> contract fully defined (FR-A4b); testnet/mainnet routing env vars
> added (FR-A4); EIP-3009 authorization window enforced server-side
> (FR-A4c); test infrastructure deliverables committed (§ 5.5).
>
> Audit reports preserved at `specs/SPEC-001-audit.md` (round-1) and
> `specs/SPEC-001-v0-2-audit.md` (round-2)."

### Final cleanup pass

After all fixes applied:

1. Grep for stale terms that should be absent:
   ```
   grep -nE 'review_jobs_failure_mode_check|cost_cap_exceeded.*part of migration|set to ~10 minutes by the skill runner' specs/SPEC-001-aeon-x402.md
   ```
   Zero matches expected.

2. Grep for new terms that MUST be present:
   ```
   grep -nE 'insufficient_channel_balance|ANTFLEET_X402_TREASURY|X402_NETWORK|X402_USDC_ASSET|X402_FACILITATOR|x402_pay_to|treasury_unconfigured|x402_authorization_window_too_long|FR-A4b|FR-A4c' specs/SPEC-001-aeon-x402.md
   ```
   All terms expected to appear at least once.

3. Verify change-log v0.3 entry references every audit finding ID
   (C2-1, C2-2, C2-3, C2-4, C2-5, C2-6, C2-7, C2-8).

4. Verify § 7 heading says "Audit findings encoded in this spec"
   (no version number).

5. Verify § 11 Build steps now has 7 items (was 6 in v0.2 — one
   prereq added as 1a, one postreq added as 7).

6. Verify spec compiles as readable markdown (no broken tables, no
   unclosed code fences).

## Process

1. Read the required materials above.

2. Read SPEC-001 v0.2 fully so you know what's there.

3. Run the cross-check grep for production `failure_mode` literals:
   ```
   grep -rn "failure_mode" apps/web/app apps/web/lib | grep -iE "'[a-z_]+'" | sort -u
   ```
   Document any unexpected literals in the handback summary.

4. Apply fixes in section order: CHG-LOG → C2-1 → C2-2 → C2-3 → C2-4 →
   C2-5 → C2-6 → C2-7 → C2-8 → cleanup pass.

5. Self-review pass (cleanup checklist above).

6. Print a 200-word handback summary to stdout listing:
   - Version bump applied (v0.2 → v0.3)
   - Count of audit findings addressed by category
   - Confirmation: no channel-rail regression introduced (CHECK dropped,
     not expanded)
   - Confirmation: dual-rail isolation preserved
   - Confirmation: aeon-gate removability preserved
   - Confirmation: v1 scope discipline preserved
   - Any unexpected `failure_mode` literals discovered during cross-check
   - Spec line count before/after (target growth: 80-150 lines)

7. Do NOT commit. Operator reviews + commits.

## What NOT to do

- Do NOT edit production source code, migrations, or other spec docs.
- Do NOT add the CHECK constraint with an expanded allow-list; the
  decision is to DROP entirely. Expanding would create the same
  schema/code coupling problem on the next failure_mode addition.
- Do NOT change FR-C3 (aeon-gate removability) or FR-E1 (pipeline
  reuse). These invariants are unchanged in this pass.
- Do NOT introduce new OOS items, new OQs, or new FRs beyond what's
  prescribed (FR-A4b and FR-A4c are explicitly prescribed; no other
  new FRs).
- Do NOT pull in any v2-deferred content (Bankr listing, sybil scoring,
  adversarial hardening, private-via-x402, PR-comment-in-x402).
- Do NOT exceed ~200 lines of changes. If you're approaching that
  ceiling, stop and re-check the fixes against this prompt.
- Do NOT commit. Operator commits.

## Expected size of diff

  SPEC-001 v0.2 → v0.3: ~80-150 lines changed out of ~1488 total.
  Major additions:
    - FR-A4 full rewrite (env var table) — ~30 lines
    - FR-A4b (treasury env contract) — ~25 lines
    - FR-A4c (EIP-3009 window enforcement) — ~25 lines
    - § 5.5 (test infrastructure) — ~50 lines
    - § 7 (audit findings encoded) — ~15 lines
    - Migration 0028 SQL rewrite — ~15 lines
  Minor edits:
    - Change log v0.3 entry — ~10 lines
    - FR-A9 parenthetical removal — ~2 lines
    - FR-B3 step 2a addition — ~5 lines
    - AC-4 step 5 addition — ~5 lines
    - AC-7 file enumeration — ~3 lines
    - AC-11 step 4 update — ~3 lines

If diff exceeds ~200 lines you've likely introduced content beyond the
prescribed fixes. Stop and audit your changes against this prompt.

When done, print the handback summary and stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist (quick — ~5 min):

1. **Diff scope** — `git diff specs/SPEC-001-aeon-x402.md | wc -l`
   should be in the 80–200 range. Wildly larger = scope creep.

2. **CHECK constraint absent** — `grep -c 'review_jobs_failure_mode_check' specs/SPEC-001-aeon-x402.md`
   should return 0 (constraint dropped entirely).

3. **New env var contracts present** — `grep -cE 'X402_NETWORK|X402_USDC_ASSET|X402_FACILITATOR|ANTFLEET_X402_TREASURY' specs/SPEC-001-aeon-x402.md`
   should return ≥4.

4. **EIP-3009 window enforcement present** — `grep -nE 'validBefore|x402_authorization_window' specs/SPEC-001-aeon-x402.md`
   should show FR-A4c content.

5. **§ 5.5 test infrastructure present** — `grep -nE '^## 5\.5' specs/SPEC-001-aeon-x402.md`
   should match once.

6. **§ 7 rewritten** — `grep -nE '^## 7' specs/SPEC-001-aeon-x402.md`
   should show "Audit findings encoded in this spec" (no v0.1 marker).

Then commit. Suggested message:

```
SPEC-001 v0.3: round-2 audit closing fixes

Closes all 9 round-2 findings (1 CRITICAL, 4 MAJOR, 3 MINOR, 1 QUESTION).

CRITICAL  C2-1: Migration 0028 CHECK constraint dropped entirely
                (production rail uses 'insufficient_channel_balance',
                gated at app layer via refund.ts already).

MAJOR     C2-2: FR-A4b defines ANTFLEET_X402_TREASURY contract
                (EIP-55 format, same-as-channel default, fail-closed
                on missing, settle-address pinning).
          C2-3: FR-A4 rewritten with X402_NETWORK / X402_USDC_ASSET /
                X402_FACILITATOR env vars; Sepolia USDC pinned to
                Circle official address.
          C2-4: FR-A4c enforces EIP-3009 authorization window —
                skill mints 600s; server hard ceiling 900s; per-row
                validBefore persistence prevents post-expiry settles.
          C2-5: § 5.5 commits to fixture repo, migration script,
                seed rows, and review-level receipt page as in-scope
                v1 deliverables.

MINOR     C2-6: Change-log v0.2 entry gains x402-URL-default sub-bullet.
          C2-7: AC-7 enumerates the channel-rail test gate set
                explicitly (no more "etc.").
          C2-8: § 7 renamed; round-1 + round-2 closures summarized.

QUESTIONS Q2-1: Package version pinning remains process-gated
                (no spec change).

Invariants preserved: dual-rail isolation, aeon-gate removability,
v1 scope discipline (no OOS items pulled in).

Channel-rail regression risk: ZERO — CHECK dropped, not expanded.

Audit re-run: narrow (per round-2 auditor recommendation; the
remaining CRITICAL was a single SQL block, not structural).
```

After commit, run a **narrow re-audit** scoped to the changed sections
only. Use the existing `AUDIT_SPEC_001_PROMPT.md` but instruct the
auditor to focus on:
- § 5.3 (migration 0028 SQL) for C2-1 closure verification
- FR-A4 / FR-A4b / FR-A4c for C2-2/C2-3/C2-4 closure verification
- § 5.5 for C2-5 closure verification
- Spot-check that no new regressions appeared in unchanged sections

Expected v0.3 verdict: **READY TO BUILD** (closure rate target: 9/9
round-2 findings closed + 0 new findings).

- If READY TO BUILD: write `BUILD_SPEC_001_IMPL_PROMPT.md`. Implementation begins.
- If NEEDS REVISION: extremely narrow fix (likely a single MINOR if
  anything), then ship.

Expected total path: this fix → 1 narrow audit round → BUILD prompt.
Target: SPEC-001 locked by 2026-05-31 so the ~1-week build can ship
by 2026-06-07 (one day ahead of original 2026-06-09 target).
