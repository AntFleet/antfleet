# Build prompt — SPEC-001 v0.4 implementation

Operator-paste prompt to implement SPEC-001 (Aeon x402 pull-mode review skill).

Unlike `BUILD_SPEC_*_PROMPT.md` files that produce the spec document
itself (the macprovider convention), this prompt produces **working
code**. It is the implementation phase — the spec is locked at v0.4
and is the normative input.

**Spec lifecycle complete:**
- v0.1 → v0.2: round-1 audit (Codex GPT-5) found 2C + 9M + 3m + 4Q, all closed
- v0.2 → v0.3: round-2 audit (Claude Opus) found 1C + 4M + 3m + 1Q, all closed
- v0.3 → v0.4: round-3 narrow audit (Claude Opus) found 1 MINOR doc gap, closed
- **v0.4 verdict: READY TO BUILD** (zero open spec findings)

Run in **Claude Code** with model = **opus** (this is multi-day,
multi-surface backend work; opus reasoning is justified). Expected
duration: ~7–10 days of focused implementation, broken into the build
steps below. The prompt is designed to run as a single long-lived
session, but each numbered step is a natural checkpoint where you can
pause + resume.

Paste everything between `=== BEGIN PROMPT ===` and `=== END PROMPT ===`
into a fresh Claude Code session rooted at `/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are implementing SPEC-001 (Aeon x402 pull-mode review skill) for
AntFleet. The spec document is locked at v0.4 and is your normative
input. Your output is working code, integration tests, a migration,
a new skill variant in a sibling repo, and a one-line PR to a third
repo.

You are NOT writing or editing the spec. If you find ambiguity, log
it in the implementation notes (see below) and proceed with your best
interpretation — do NOT modify SPEC-001-aeon-x402.md.

## Mission

Build the x402-rail pull-mode review path described in SPEC-001 v0.4
end-to-end. After this build, an aeon agent with a funded wallet on
Base can invoke `pr-review-antfleet-x402` and receive a real two-
model-consensus review of any public PR, paying $0.50 USDC per call
via the Coinbase x402 v2 protocol, without installing the AntFleet
GitHub App on the target repo.

Critical product gate: dual-rail isolation. The existing channel-rail
review path is in production and must remain observably unchanged.
The x402 rail is additive; it shares the review pipeline but lives in
parallel for payment, authentication, fetch, and receipt rendering.

## Critical constraints (load-bearing)

**1. Dual-rail isolation invariant (FR-E1).** `apps/web/lib/review-pipeline.ts`
`reviewPR()` is called identically from both rails. NO rail-aware code
inside the pipeline. If you find yourself adding `if (paymentRail === 'x402')`
inside `reviewPR()` or downstream primitives, STOP and refactor the
caller. The pipeline is rail-agnostic by contract.

**2. Aeon-gate removability invariant (FR-C3).** The aeon-context gate
MUST be implementable as a single middleware whose removal does not
require touching the endpoint handler, the review pipeline, the worker,
or the receipt rendering. v2 will flip a flag to open access; the
architecture MUST permit it without code changes elsewhere.

**3. Channel-rail regression == CRITICAL bug.** The existing channel
rail (POST /api/v1/installations/{id}/review, the GitHub App webhook
flow, the wallet-bound channel paywall) MUST behave identically before
and after this build. Any test in `apps/web/**/*.test.ts` that passed
before this build MUST pass after, without modification. This is gated
by AC-7.

**4. v1 scope discipline.** SPEC-001 § 2.2 OUT-OF-SCOPE list is
authoritative. Do NOT build:
- Bankr registry submission or BankrBot/skills PR
- Sybil scoring, adversarial-input hardening, mid-flight inference abort
- Private repo support via x402
- PR comment posting from x402 reviews
- Pricing differentiation between rails
- Multi-chain or multi-asset support beyond USDC on Base
- True SHA-only review (SHA targets must resolve to one open PR head)

If a feature would benefit the build but isn't in v1 scope, log it in
implementation notes as a v2 candidate and skip.

**5. Source-of-truth alignment.** When the spec says "matches existing
behavior at `<path>:<line>`", read that file FIRST and mirror its
actual semantics. The spec went through 3 audit rounds specifically
because earlier drafts invented behaviors that didn't match production.
Do NOT repeat that pattern. Production code at `apps/web/` is the
source of truth.

**6. No `--no-verify` on commits.** Pre-commit hooks exist for a
reason. If a hook fails, fix the underlying issue.

## Required reading (in order, fully — before writing any code)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md v0.4
   — read fully. This is the normative spec. Pay particular attention
   to: § 0 (invocation), § 2 (scope), § 4 Parts A-E (FRs), § 5
   (interface contracts, especially § 5.5 test infrastructure), § 8
   (acceptance criteria), § 10 (open questions — operator answers
   needed before AC-1 mainnet runs), § 11 (build steps).

2. /Users/augstar/projects/antfleet/specs/SPEC-001-v0-3-audit.md
   — the audit confirming v0.3 (and by extension v0.4) is build-ready.
   Read the AC coverage matrix to understand which FRs have which AC
   gates.

3. /Users/augstar/projects/antfleet/apps/web/lib/review-pipeline.ts
   — `reviewPR()` is the entrypoint you reuse without modification.
   Understand its signature (`prNumber: number` is required, even for
   SHA-input requests — SHA targets resolve to PR head per FR-A7).

4. /Users/augstar/projects/antfleet/apps/web/lib/review-job-worker.ts
   /Users/augstar/projects/antfleet/apps/web/lib/review-job-queries.ts
   — existing worker that processes `review_jobs` rows. Your x402
   jobs land in the same table; the worker dispatches based on
   `payment_rail`.

5. /Users/augstar/projects/antfleet/apps/web/lib/paywall/refund.ts
   — REFUNDABLE_FAILURE_MODES is the authoritative refund-eligibility
   enum. Your x402 settle/no-settle decisions reference this set per
   FR-A8.

6. /Users/augstar/projects/antfleet/apps/web/lib/paywall/invoice.ts
   /Users/augstar/projects/antfleet/apps/web/lib/paywall/gate.ts
   — existing channel-rail paywall surface. Your x402 paywall is a
   separate path; do not modify these. Read them for the existing
   x402-shaped invoice payload pattern (the spec's FR-A2 v2 payload
   is the new shape; the existing invoice.ts is v1-shaped for legacy
   compat — do not edit it).

7. /Users/augstar/projects/antfleet/apps/web/app/api/v1/installations/[id]/review/route.ts
   /Users/augstar/projects/antfleet/apps/web/app/api/v1/installations/[id]/review/[jobId]/route.ts
   — reference async API. Your x402 routes mirror the same shape per
   FR-A5 (response: `jobId`, `statusUrl`, `expectedDurationSec`).
   Do NOT modify these routes.

8. /Users/augstar/projects/antfleet/apps/web/lib/api-v1/responses.ts
   — `jsonError()` helper. All x402 error responses use this envelope
   per FR-C1/FR-D1.

9. /Users/augstar/projects/antfleet/apps/web/lib/github-files.ts
   — existing channel-rail PR fetch (uses installation token). You
   create a sibling path for unauthenticated public fetch per FR-A6.

10. /Users/augstar/projects/antfleet/apps/web/db/migrations/
    — list contents to confirm 0027 is current head; your migration
    is 0028. Read `0024_review_jobs.sql` and `0027_review_jobs_billing_pending.sql`
    for the existing schema you're extending.

11. /Users/augstar/projects/antfleet/apps/web/db/queries.ts
    /Users/augstar/projects/antfleet/apps/web/app/receipts/[id]/page.tsx
    — existing finding-level receipt. Your review-level receipt is a
    SIBLING surface at `apps/web/app/receipts/review/[id]/page.tsx`;
    do NOT modify the existing finding-level page.

12. https://docs.x402.org/core-concepts/http-402 (web-fetch)
    https://docs.x402.org/guides/migration-v1-to-v2 (web-fetch)
    https://docs.cdp.coinbase.com/x402/network-support (web-fetch)
    — x402 v2 protocol, package names (`@x402/core`, `@x402/express`,
    `@x402/evm`), CDP facilitator endpoint.

13. https://github.com/antfleet/aeon-skills (clone or browse)
    — existing v2 channel-rail skill at `pr-review-antfleet/`. Your
    new skill (`pr-review-antfleet-x402/`) mirrors its structure per
    FR-B1–B4.

14. https://github.com/aaronjmars/aeon/blob/main/skill-packs.json
    — registry entry for AntFleet. Your one-line PR appends
    `pr-review-antfleet-x402` to the `skills` array per FR-B5.

## Companion implementation notes (REQUIRED)

Create and maintain `apps/web/lib/x402/implementation-notes.md` as you
work. This is your design-decision log. The file should capture:

- **Design decisions:** choices made where the spec was ambiguous
  (e.g., specific x402 facilitator library API choices, exact
  error code spellings, log structure)
- **Deviations:** places where you intentionally departed from the
  spec text, and why
- **Tradeoffs:** alternatives considered and why you picked what you did
- **Open questions:** anything you want the operator to confirm or
  revise before AC-1 mainnet runs
- **v2 candidates:** features you noticed would be useful but
  intentionally skipped per § 2.2 OOS list

Append to this file as you go; do not batch-edit at the end.

## Build steps

Per SPEC-001 § 11. Each step has a clear deliverable and a quick
self-check gate. Pause between steps if needed; resume in the same
session.

### Step 1a — Build prereqs (fixture repo + seed rows + migration script)

Per § 5.5 of the spec. Three artifacts, all gateable independently.

**1a.1 Fixture repo `antfleet/x402-fixture`** (per § 5.5.1)

Create a public repo at `https://github.com/antfleet/x402-fixture`
(use `antfleet-ops` gh account per project memory):

```bash
gh auth switch -u antfleet-ops
gh repo create antfleet/x402-fixture --public --description "Stable test fixture for AntFleet x402 acceptance tests. Not for production use."
```

Initialize with:
- `README.md` explaining the repo's test-only purpose
- A minimal TypeScript source tree (3-5 files; pure type-level demos OK)
- Open PR #1 with a known small diff (~50 lines) for happy-path AC-1/AC-1a runs
- Open PR #2 with a forced-large diff (~50K lines changed) for AC-10
  cost-cap testing — generate via a script that produces repetitive
  content (do NOT commit binary blobs; use scripted text)

After creation, RECORD the head SHA of PR #1 in implementation notes —
it's referenced by AC-1, AC-1a, AC-10. The SHA MUST be stable across
test runs.

**1a.2 Migration apply script `apply-migration-0028.ts`** (per § 5.5.2)

Per project memory: "migrations need manual apply via
`apply-migration-XXXX.ts --apply`". Mirror the structure of any
existing `apply-migration-*.ts` in the repo (likely
`apps/web/db/migrations/apply-migration-0027.ts` or similar).

The script:
- `node apply-migration-0028.ts` → dry-run printing the SQL
- `node apply-migration-0028.ts --apply` → actually apply
- Reports caller_wallet + payment_rail + x402_pay_to column presence
  and the absence of `review_jobs_failure_mode_check` after successful
  apply (per AC-11)
- Idempotent (re-running after success is a no-op, exits 0)

**1a.3 Seed script `x402-receipt-test-fixtures.ts`** (per § 5.5.3)

`apps/web/db/seed/x402-receipt-test-fixtures.ts` seeds three rows for
AC-12:
- Row 1: `status=complete`, `payment_rail=x402`, 2 findings
- Row 2: `status=complete`, `payment_rail=x402`, 0 findings
- Row 3: `status=failed`, `payment_rail=x402`, `failure_mode=provider_error`,
  0 findings

All three reference the AC-1 fixture repo PR #1 head SHA recorded in 1a.1.

**Self-check gate for Step 1a:**
- `gh repo view antfleet/x402-fixture` shows the repo public
- Fixture PR #1 has a stable head SHA recorded in implementation notes
- `node apps/web/db/migrations/apply-migration-0028.ts` (dry-run) prints valid SQL
- `node apps/web/db/seed/x402-receipt-test-fixtures.ts --help` exists

### Step 1 — Migration 0028 (the actual schema change)

Per § 5.3 of the spec (the SQL block in v0.4 — confirm you have the
post-C2-1 version with NO failure_mode CHECK).

`apps/web/db/migrations/0028_review_jobs_x402.sql`:

```sql
-- Per SPEC-001 v0.4 § 5.3 (post-C2-1 / round-2 audit closure).
--
-- Adds the columns x402 jobs need (caller_wallet + payment_rail + x402_pay_to)
-- plus indexes. Does NOT add a CHECK constraint on failure_mode; production
-- channel rail writes additional literals (e.g. 'insufficient_channel_balance')
-- gated at the application layer via apps/web/lib/paywall/refund.ts.

ALTER TABLE review_jobs
  ADD COLUMN IF NOT EXISTS caller_wallet text,
  ADD COLUMN IF NOT EXISTS payment_rail text NOT NULL DEFAULT 'channel'
    CHECK (payment_rail IN ('channel','x402')),
  ADD COLUMN IF NOT EXISTS x402_pay_to text;

UPDATE review_jobs SET payment_rail = 'channel' WHERE payment_rail IS NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_caller_wallet
  ON review_jobs (caller_wallet)
  WHERE caller_wallet IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_jobs_payment_rail_created
  ON review_jobs (payment_rail, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_jobs_x402_pay_to
  ON review_jobs (x402_pay_to)
  WHERE x402_pay_to IS NOT NULL;
```

Apply via the script from 1a.2: `node apply-migration-0028.ts --apply`.

**Self-check gate for Step 1:**
- `psql ... -c "\d review_jobs"` shows the three new columns
- No `review_jobs_failure_mode_check` constraint exists
- All three indexes are present
- Re-running `--apply` exits 0 with no errors (idempotency)

Also: write `apps/web/db/migrations/0028.test.ts` per AC-11 — the
migration apply test.

### Step 2 — x402 endpoint + middleware

The biggest step. Six sub-components, each isolated.

**2.1 `apps/web/lib/x402/env.ts`** — env var validation at startup

Per FR-A4 + FR-A4b: validate `X402_NETWORK`, `X402_USDC_ASSET`,
`X402_FACILITATOR`, `ANTFLEET_X402_TREASURY`, `AEON_GATE_SECRETS`,
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`. Process exits with a clear
error if any required var is missing/malformed. Also enforces the
network/asset consistency invariant (mainnet network ⇔ mainnet asset).

**2.2 `apps/web/lib/x402/aeon-gate.ts`** — gate middleware

Per FR-C1, FR-C2. HMAC verification, kid lookup, 5-min validity + 30s
skew tolerance, 24h overlapping rotation. Exposes a single
`requireAeonContext()` middleware function. Toggled by env var
`X402_REQUIRE_AEON_CONTEXT` (default `true`); when false, middleware
no-ops (this is the FR-C3 removability invariant — verify by adding
unit tests that flip the flag).

**2.3 `apps/web/lib/x402/rate-limit.ts`** — per-wallet + per-repo limits

Per FR-D1 + FR-D2. Per-wallet: 10 successful reviews per rolling 1h.
Per-repo: 1 fresh review per `(owner, repo, sha)` per 10min (cross-
wallet cached). Implemented as DB queries against `review_jobs` (no
new Redis dependency). 429 responses use `jsonError()` envelope plus
top-level `retry_after_seconds`.

**2.4 `apps/web/lib/x402/facilitator.ts`** — x402 client wrapper

Per FR-A2, FR-A4, FR-A4b, FR-A4c, FR-A9. Wraps `@x402/core` +
`@x402/express` + `@x402/evm` with the verify-then-defer-settle
pattern. Critical: the middleware MUST be configured in `verifyOnly`
mode (or bypassed with explicit `/verify` and `/settle` calls from
the route handler). Auto-settling middleware is INCOMPATIBLE with
FR-A9 and MUST NOT be used.

The wrapper exposes:
- `verifyPayment(req)` — calls facilitator `/verify`, returns the
  validated payment payload (incl. validAfter/validBefore). Throws
  on past-time, future-time, or window-too-long per FR-A4c.
- `settlePayment(job)` — calls facilitator `/settle` using the
  persisted authorization from `job.x402_payment_payload`. Refuses if
  `now > job.x402_valid_before` or if `job.x402_pay_to !== current X402_TREASURY`.

**2.5 `apps/web/lib/github-files-public.ts`** — public-repo fetch

Per FR-A6. Mirrors `github-files.ts:fetchChangedFilesWith()` but uses
unauthenticated Octokit (or with `GITHUB_PUBLIC_TOKEN` if set for rate
headroom). Fetches PR diff via `repos.compareCommits` or `pulls.listFiles`
WITHOUT installation auth. Returns the same `ChangedFile[]` shape so
the downstream pipeline doesn't notice.

If the repo is private (404/403 on unauth fetch), throws a typed error
that the route handler translates to `failed`/`failure_mode='user_input'`/`error_code='repo_not_accessible'`
per FR-A6.

**2.6 `apps/web/app/api/v1/review/x402/route.ts`** — POST handler

Orchestrates: aeon-gate → x402 verify → rate-limit → idempotency
check → SHA resolution to PR head (per FR-A7) → migration-0028 row
insert → 202 response with `jobId`, `statusUrl`, `expectedDurationSec`
(matching channel-rail shape per FR-A5).

`apps/web/app/api/v1/review/x402/[jobId]/route.ts` — GET handler.
Returns job state. Public read (no auth — the job is queryable by
anyone with the jobId, which is a UUID).

**2.7 Worker dispatch update** — `apps/web/lib/review-job-worker.ts`

The existing worker picks up `review_jobs` rows. Extend dispatch to:
- Check `payment_rail` on each row
- For `x402` rail: use `github-files-public.ts` for fetch; call
  `facilitator.settlePayment(job)` for terminal `complete` or
  `user_input` per FR-A8; do nothing (let authorization expire) for
  other terminal states
- For `channel` rail: unchanged behavior

This is a delicate edit — verify the dispatch table reads cleanly and
no rail-aware branching leaks into `reviewPR()` itself.

**Self-check gate for Step 2:**
- All six sub-components have unit tests (`apps/web/lib/x402/*.test.ts`)
- Endpoint integration test exists at `apps/web/app/api/v1/review/x402/route.test.ts`
- `curl -X POST .../review/x402` with no payment returns valid x402 v2 402 payload
- `curl ...` with invalid X-Aeon-Context returns 403 with correct envelope
- AC-2 + AC-9 pass

### Step 3 — Skill variant `pr-review-antfleet-x402`

Per § 4 Part B (FR-B1–B5). Clone `antfleet/aeon-skills` locally:

```bash
gh repo clone antfleet/aeon-skills /tmp/aeon-skills-build
cd /tmp/aeon-skills-build
```

Create `pr-review-antfleet-x402/` with:

- `SKILL.md` per FR-B2 (frontmatter, prerequisites, env vars,
  exit codes)
- `package.json` with `@x402/core`, `@x402/evm`, etc. as deps
- `run.mjs` per FR-B3 — parses TARGET, constructs x402 client,
  handles 402-sign-retry, polls, writes output

Also update `skills-pack.json` at the pack root to declare the new
skill:

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

Open a PR to `antfleet/aeon-skills` with these additions. Get it
reviewed (or self-merge as antfleet-ops) before Step 6.

**Self-check gate for Step 3:**
- `./add-skill antfleet/aeon-skills pr-review-antfleet-x402` succeeds
  in a fresh aeon project (smoke test against the staging endpoint)
- AC-1a end-to-end on Base Sepolia passes

### Step 4 — Review-level receipt surface

Per § 5.5.4 + FR-E2.

`apps/web/app/receipts/review/[id]/page.tsx` — server component that
loads a `review_jobs` row by `review_id` and renders:
- Header: repo, PR (resolved), SHA, payment rail, status, settlement
  status
- Body: all findings (or "no findings" notice) — each with a link to
  the existing finding-level receipt
- Footer: link back to the review_jobs row in operator dashboard (if
  exists)

DO NOT modify `apps/web/app/receipts/[id]/page.tsx` (the existing
finding-level surface). The two pages are siblings.

Public read (no auth required).

**Self-check gate for Step 4:**
- AC-12 passes (3 fixture rows render correctly)
- Existing `/receipts/{finding_id}` URL behavior unchanged
- Lighthouse / a11y check on the new page is reasonable

### Step 5 — Integration tests (AC-1 through AC-12)

Each AC needs a runnable test. Naming convention:
`apps/web/lib/x402/ac-NN.test.ts` or `apps/web/app/api/v1/review/x402/ac-NN.test.ts`.

Priority order (gate-critical first):
- AC-1a (Base Sepolia smoke) — CI gate; runs on every deploy
- AC-2 (gate rejection) — fast unit-ish test
- AC-7 (no channel regression) — runs the existing channel-rail test
  suite unchanged; this is the dual-rail isolation gate
- AC-9 (gate removability flip) — toggles env var
- AC-11 (migration apply) — runs the migration script
- AC-12 (receipt rendering) — uses seed rows from Step 1a.3
- AC-3, AC-4, AC-5, AC-6, AC-10 — idempotency, refund, rate-limit,
  cooldown, cost-cap
- AC-1 (mainnet smoke) — gated by OQ-5 resolution (CDP API keys
  provisioned)
- AC-8 (registry listing) — manual gate; runs after Step 6 merge

**Self-check gate for Step 5:**
- `pnpm test` (or `npm test`) passes all new tests
- `pnpm test apps/web/app/api/v1/installations/[id]/review` passes
  unchanged (channel-rail regression check)
- CI workflow updated to run AC-1a on every deploy

### Step 6 — Registry PR to `aaronjmars/aeon`

Per FR-B5. After Step 3's PR is merged into `antfleet/aeon-skills`:

```bash
gh repo clone aaronjmars/aeon /tmp/aeon-build
cd /tmp/aeon-build
git checkout -b antfleet-x402-skill
```

Edit `skill-packs.json` and `docs/community-skill-packs.md` per § 5.4
of the spec (the diff is one-line, no design decisions).

Open the PR with title:
`docs(skill-packs): add pr-review-antfleet-x402 to AntFleet entry`

Body should reference SPEC-001 + the fact AntFleet entry is already
`trust_level: trusted`, so no new review is required.

**Self-check gate for Step 6:**
- PR opens cleanly with the one-line diff
- After merge: `./add-skill antfleet/aeon-skills pr-review-antfleet-x402`
  succeeds in a fresh aeon project
- AC-8 passes

### Step 7 — Build-postreq verification

Per § 11 step 7. Run through the full AC-1 through AC-12 list. All
must pass green for build-complete.

Document any failures or operator-decisions-needed in implementation
notes for the handback.

## Operator-decision dependencies (block before mainnet AC-1)

Per § 10 (still-open OQs):

| OQ | Blocking step | Operator action needed |
|---|---|---|
| OQ-1 (gate token secret distribution) | AC-1 mainnet (not blocking AC-1a Sepolia) | Aaron confirms aeon runtime can hold `AEON_GATE_SECRET`; secret distributed |
| OQ-2 (per-wallet rate limit value) | AC-5 | Operator confirms 10/hour is the starting value (or picks alternative) |
| OQ-3 (per-repo cooldown window) | AC-6 | Operator confirms 10 minutes |
| OQ-5 (CDP API keys provisioned) | AC-1 mainnet | `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` provisioned in production env |

AC-1a (Sepolia) and AC-2 through AC-12 do NOT depend on these — they
run against staging with the x402.org reference facilitator and
operator-default rate-limit / cooldown values.

## Handback after Step 7

When all 7 build steps are complete (or you're blocked at a step),
print to stdout:

1. Which steps completed (1a through 7)
2. AC pass status — table with each AC and pass/fail/blocked
3. Open operator decisions (OQ-1, OQ-2, OQ-3, OQ-5) — which are
   resolved, which still block mainnet
4. Files created (list paths grouped by step)
5. Files modified (list paths — should be a small set, mostly the
   worker)
6. Lines of new code (rough total)
7. Lines of tests (rough total)
8. Any deviations from the spec logged in implementation notes
9. Any v2 candidates logged in implementation notes
10. Recommendation: proceed to mainnet AC-1 / hold for operator
    decisions / hold for fix

Do NOT commit the production changes. Operator reviews each commit
boundary (typically per-step).

## What NOT to do

- Do NOT edit the spec (`specs/SPEC-001-aeon-x402.md`).
- Do NOT modify channel-rail code paths
  (`apps/web/lib/paywall/*`, `apps/web/app/api/v1/installations/*`,
  `apps/web/lib/github-files.ts`, `apps/web/app/receipts/[id]/page.tsx`).
  These are explicitly preserved for dual-rail isolation.
- Do NOT add rail-aware branching inside `apps/web/lib/review-pipeline.ts`
  or downstream review primitives. Branch at the dispatcher / route
  level only.
- Do NOT pull in v2-deferred features (Bankr, sybil, adversarial
  hardening, private-via-x402, PR-comment-in-x402, multi-chain).
- Do NOT auto-settle x402 payments. Verify-then-defer-settle is
  load-bearing.
- Do NOT use `--no-verify` or `--no-gpg-sign` on commits.
- Do NOT commit the production changes yourself. Operator commits per
  step.
- Do NOT proceed to mainnet AC-1 before OQ-1 and OQ-5 are resolved.

## Expected total deliverable size

| Component | Files | LOC rough |
|---|---|---|
| Step 1a (fixtures + seeds + migrate script) | 5-7 | ~400 |
| Step 1 (migration SQL) | 2 | ~50 |
| Step 2 (x402 endpoint + middleware) | 8-10 | ~1200 |
| Step 3 (skill variant) | 3 | ~300 |
| Step 4 (review-level receipt page) | 2-3 | ~250 |
| Step 5 (integration tests) | 12-15 | ~1500 |
| Step 6 (registry PR) | 1 PR | n/a |
| Implementation notes | 1 | ~200 |
| **Total** | **~30-35 files** | **~3900 LOC** |

If your output diverges significantly (>2× larger), you've likely
introduced scope creep. Re-check against § 2.2 OOS list.

When done, print the handback summary and stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist (per build step):

**After Step 1a (build prereqs):**
- [ ] `antfleet/x402-fixture` repo exists, public, with PR #1 + PR #2
- [ ] Fixture PR #1 head SHA recorded in implementation notes
- [ ] `apply-migration-0028.ts` dry-runs cleanly
- [ ] Seed script exists with `--help` flag

**After Step 1 (migration):**
- [ ] Migration applied to staging DB
- [ ] No `review_jobs_failure_mode_check` constraint
- [ ] Migration test passes
- [ ] Migration is idempotent

**After Step 2 (endpoint):**
- [ ] All 6 sub-components present
- [ ] AC-2 + AC-9 pass against staging
- [ ] Channel-rail tests still pass (regression check)
- [ ] No `if (paymentRail === ...)` inside `reviewPR()`

**After Step 3 (skill):**
- [ ] `antfleet/aeon-skills` PR merged
- [ ] `./add-skill ...` smoke test passes
- [ ] AC-1a (Base Sepolia) passes

**After Step 4 (receipt page):**
- [ ] AC-12 passes
- [ ] Existing `/receipts/{id}` unchanged

**After Step 5 (tests):**
- [ ] All AC tests green (except AC-1 mainnet if OQ-1/OQ-5 unresolved)
- [ ] CI gates AC-1a on every deploy

**After Step 6 (registry PR):**
- [ ] `aaronjmars/aeon` PR opened
- [ ] After merge: AC-8 passes

**After Step 7 (postreq):**
- [ ] All ACs green or blocked-pending-operator
- [ ] Handback summary delivered

## Operator-decision gates before mainnet (OQ resolution)

Before AC-1 mainnet runs (and before the partnership goes live to aeon
users), the four OQs need answers:

- **OQ-1** — Talk to Aaron: aeon runtime distributes `AEON_GATE_SECRET`?
  HMAC ships. Otherwise fall back to JWT (spec change required).
- **OQ-2** — Pick rate-limit starting value (default: 10/hour).
- **OQ-3** — Pick cooldown window (default: 10 min).
- **OQ-5** — Provision CDP API keys in production env.

AC-1a (Sepolia) and AC-2 through AC-12 do NOT block on these.

## Suggested commit cadence

One commit per build step, each with a clear message:

```
SPEC-001 step 1a: x402 build prereqs (fixture repo, migration script, seed rows)
SPEC-001 step 1: migration 0028 review_jobs x402 columns
SPEC-001 step 2.1: x402 env validation
SPEC-001 step 2.2: aeon-gate middleware
SPEC-001 step 2.3: x402 rate limiting
SPEC-001 step 2.4: x402 facilitator wrapper (verify-then-defer-settle)
SPEC-001 step 2.5: github-files public fetch path
SPEC-001 step 2.6: /api/v1/review/x402 routes
SPEC-001 step 2.7: review-job-worker dispatch update
SPEC-001 step 3: aeon-skills pr-review-antfleet-x402 variant
SPEC-001 step 4: review-level receipt page
SPEC-001 step 5.N: AC-NN integration tests
SPEC-001 step 6: aeon registry PR (separate repo)
SPEC-001 step 7: build-postreq verification + handback
```

Granular commits make rollback trivial if a sub-component breaks. Each
commit must pass pre-commit hooks (lint, types, channel-rail tests).

## Expected total path

- Step 1a + Step 1 (~1 day): infrastructure
- Step 2 (~3 days): the bulk — endpoint + middleware + worker dispatch
- Step 3 (~1 day): skill variant + smoke test against staging
- Step 4 (~0.5 day): receipt page
- Step 5 (~2 days): integration tests (parallel-ish with Step 2-4)
- Step 6 (~0.5 day): registry PR + merge
- Step 7 (~0.5 day): postreq verification + handback

Target: ~7-8 working days. Buffer for OQ resolution + unexpected
issues: ~10 calendar days.

Ship target: 2026-06-06 to 2026-06-09 (depending on when OQ-1 + OQ-5
resolve and when Aaron's aeon public instance is live to receive the
install).
