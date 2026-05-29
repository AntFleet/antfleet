# Audit prompt — SPEC-001 (Aeon x402 pull-mode skill) second-opinion review

Operator-paste prompt to audit `specs/SPEC-001-aeon-x402.md` v0.1.

Run with a **different model than the one that authored the spec** for
cross-model independence. SPEC-001 v0.1 was authored by Claude; recommended
auditor is Codex CLI (GPT-5) or Gemini. Expected duration: ~45–60 min.

Paste everything between the markers into a fresh session rooted at
`/Users/augstar/projects/antfleet`.

---

```
=== BEGIN PROMPT ===

You are auditing SPEC-001 (Aeon x402 pull-mode review skill) for the
AntFleet project. This is the first spec authored under the AntFleet
spec-discipline pattern (adapted from the macprovider-poc corpus). Your
audit sets the rigor bar for all future AntFleet specs.

The change under audit:

  /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md
  Version: 0.1 (initial draft)

Your job: read the spec fully, audit it against the categories below,
and produce a structured audit report at:

  /Users/augstar/projects/antfleet/specs/SPEC-001-audit.md

You are NOT here to implement, rewrite, or extend this spec. Find
problems, report them, let the operator decide fixes.

## Critical constraints to honor while auditing

**1. Dual-rail isolation is the load-bearing invariant.** The existing
channel-rail review path (`POST /api/v1/installations/{id}/review` and
related) is in production and used by aeon-org + miroshark + the bench
today. SPEC-001's x402-rail addition MUST NOT change observable channel-rail
behavior. Any spec text implying a channel-rail change (different invoice
shape, different receipt schema breaking change, different debit semantics)
is a CRITICAL finding.

The pipeline reuse invariant: `apps/web/lib/review-pipeline.ts`
`reviewPR()` is called identically from both rails. No rail-aware code
permitted in the pipeline. If the spec authorizes rail-aware branching
inside the pipeline, MAJOR finding.

**2. Aeon-gate removability is load-bearing.** v1 ships with aeon-only
access via the `X-Aeon-Context` header gate. v2 will likely open the
gate. The architecture MUST permit gate removal as a single middleware
change or feature flag flip. Any spec text that couples the gate into
the review pipeline, the skill runner, or the receipt rendering is a
MAJOR finding.

**3. Backward compatibility for existing GitHub App installations.**
The `antfleet[bot]` GitHub App at https://github.com/apps/antfleet is
installed on production repos today. SPEC-001 introduces no new
required permission. No re-authorization is required. Any spec text
implying an App permission change is CRITICAL.

**4. Refund semantics MUST match between rails for shared terminal
states.** `provider_error`, `timeout`, `internal_error` always refund.
`user_error` does not refund. `complete` settles. Differences between
rails for these states are CRITICAL (financial bug).

**5. v1 scope discipline.** The OUT-OF-SCOPE list in § 2.2 is
deliberate. Bankr registry submission, sybil scoring, adversarial-input
hardening, private repo support via x402, PR comment posting in x402
mode — all explicit deferrals to v2. Spec text that retrofits any of
these into v1 is MAJOR (scope creep).

**6. No invented content.** The spec was authored from a known set of
sources (existing AntFleet code, aeon-skills v2 pack, Coinbase x402
spec, Bankr skills bench, Telegram chat context). If any normative
claim has no source passage and is not a mechanical consistency clause
required by the architecture, that is a MAJOR finding.

## Required reading (in order, fully)

1. /Users/augstar/projects/antfleet/specs/SPEC-001-aeon-x402.md
   — the spec under audit. Read fully, especially:
   - § 2.2 (out of scope) — verify the spec body honors these exclusions
   - § 4 Part A (FR-A1–A10) — x402 protocol compliance
   - § 4 Part C (FR-C1–C3) — aeon-gate removability
   - § 4 Part E (FR-E1–E4) — dual-rail isolation
   - § 5 (interface contracts) — implementability surface
   - § 8 (acceptance criteria) — coverage and measurability
   - § 10 (open questions) — discipline check

2. /Users/augstar/projects/antfleet/specs/README.md
   — house style and severity rubric.

3. /Users/augstar/projects/antfleet/apps/web/lib/review-pipeline.ts
   — existing pipeline that SPEC-001 reuses. Verify FR-E1 reuse claim
   is technically feasible without rail-aware branching.

4. /Users/augstar/projects/antfleet/apps/web/lib/paywall/invoice.ts
   /Users/augstar/projects/antfleet/apps/web/lib/paywall/gate.ts
   /Users/augstar/projects/antfleet/apps/web/lib/paywall/refund.ts
   — existing wallet-bound channel paywall. Verify SPEC-001's
   refund-semantics-parity claim (FR-A9) matches actual channel behavior.

5. /Users/augstar/projects/antfleet/apps/web/app/api/v1/installations/[id]/review/route.ts
   — existing async review route. Verify SPEC-001's claimed async
   protocol (FR-A5) matches established pattern.

6. /Users/augstar/projects/antfleet/apps/web/lib/github-files.ts
   — existing PR-fetch path. Verify FR-A6's public-repo split is
   feasible (the code may already be PR-coupled in ways that need
   refactoring).

7. /Users/augstar/projects/antfleet/CLAUDE.md (if exists)
   /Users/augstar/projects/antfleet/AGENTS.md
   /Users/augstar/projects/antfleet/ARCHITECTURE.md
   — project conventions.

8. Coinbase x402 spec at https://www.x402.org/spec (web-fetch allowed)
   — verify FR-A2's `accepts` payload shape is correct per the official
   v1 spec.

9. Public reference: https://github.com/antfleet/aeon-skills
   — existing v2 skill structure that SPEC-001's new variant mirrors.

10. Public reference: https://github.com/aaronjmars/aeon/blob/main/skill-packs.json
    — current registry shape that SPEC-001's FR-B5 PR modifies.

You may browse the rest of the repo for context. Do NOT browse
proprietary partner code.

## Audit categories — work through each

### Category A: x402 protocol compliance (HIGHEST PRIORITY)

A.1  FR-A2 402 payload shape: every field name, type, and encoding
     must match Coinbase x402 v1 spec. Check `x402Version`, `accepts[]`
     (especially `scheme`, `network`, `asset`, `maxAmountRequired`,
     `payTo`, `resource`, `maxTimeoutSeconds`).
     - Deviation that works with one facilitator but breaks others = MAJOR.
     - Deviation that breaks all facilitators = CRITICAL.

A.2  FR-A4 USDC address. Verify `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
     is the correct USDC mainnet address on Base (CAIP-2 eip155:8453).
     Wrong address = CRITICAL.

A.3  FR-A3 SIWE auth claim. The spec says "stateless x402 payment IS
     the auth proof, no JWT needed." Verify this matches Coinbase x402
     v1 (vs. SIWE/SIWX flow used by Quicknode's variant).
     - Mismatch = MAJOR.

A.4  FR-A5 async job protocol. Verify it composes cleanly with the
     existing async review API (schema head 0024, POST returns 202 +
     jobId). Any divergence from the established pattern that isn't
     justified = MAJOR.

A.5  FR-A8 terminal-states table. Verify every state has a defined
     settlement decision AND a defined refund decision. Missing
     combination = CRITICAL.

A.6  FR-A9 refund-via-void mechanism. Verify the chosen facilitator
     (OQ-5) supports `void` before settlement. If the facilitator
     auto-settles on verify, the fallback (24h refund queue) is
     specified — verify it's adequate.

### Category B: Aeon-gate removability

B.1  FR-C1 gate header. Verify 403 response shape is consistent with
     other AntFleet error envelopes (check existing `paywall/gate.ts`
     for conventions).

B.2  FR-C2 token mechanism. OQ-1 captures the open question, but the
     v1 default (HMAC over `session_id:timestamp`) is locked. Verify:
     - Replay window (5 min) is justified
     - Clock-skew tolerance is addressed (or explicitly OQ'd)
     - Secret rotation strategy is addressed (or explicitly OQ'd)

B.3  FR-C3 removability invariant. The spec claims the gate is
     "a single middleware whose removal does not require touching
     the endpoint handler or pipeline." Verify this is architecturally
     achievable, not just an aspiration. If the spec couples gate
     state into the job row or the receipt rendering, MAJOR.

### Category C: Dual-rail isolation

C.1  FR-E1 pipeline reuse. Spec claims `reviewPR()` is called
     identically from both rails. Cross-check against actual
     `apps/web/lib/review-pipeline.ts` signature — does the public
     surface accept rail-agnostic inputs?

C.2  FR-E2 receipt schema. The optional `paid_via` field is described
     as "displayed in the receipt header for transparency but NOT a
     security boundary." Verify this is consistent — does any other
     spec text grant `paid_via` security significance?

C.3  FR-E3 migration 0025. The ALTER TABLE is reversible? Backfill is
     idempotent? Verify against project memory note "schema head is
     0024; migrations need manual apply via `apply-migration-XXXX.ts
     --apply`."

C.4  FR-E4 no regression on channel rail. AC-7 covers this. Verify
     AC-7's "existing channel-rail integration tests pass without
     modification" is achievable given the schema additions.

### Category D: Refund/void parity

D.1  Cross-reference FR-A8 (terminal states) against the existing
     `apps/web/lib/paywall/refund.ts` semantics. For each shared
     terminal state, does SPEC-001 commit to the same refund
     decision?

D.2  Settlement of `complete` vs void of `provider_error`: verify the
     decision point in the worker (post-`reviewPR()` return) is the
     right place to make the settle-vs-void call.

D.3  Cost-cap-exceeded (FR-D3): a new terminal state with no channel-rail
     analog. Verify the spec is clear that this state refunds (yes,
     per the table) and that the existing channel rail would also
     benefit from this protection (note as observation, not finding).

### Category E: Abuse-infra adequacy (and scope discipline)

E.1  FR-D1 rate limit (10/wallet/hr). Verify the threat model in
     § 4 Part D — does 10/hour adequately defend against single-wallet
     budget burn? At $0.50/review, 10 reviews = $5/hour ≈ $120/day
     cap per wallet. Acceptable for v1? Note as QUESTION if uncertain.

E.2  FR-D2 per-repo cooldown (10 min). Verify the cross-wallet caching
     behavior is intentional (AC-6 tests it). Cross-wallet cache hits
     mean wallet W2 gets a free read of wallet W1's paid review —
     is this a feature or a bug? The spec frames it as a feature
     (prevents review-spam on the same SHA). Verify rationale holds.

E.3  FR-D3 cost cap (3× price = $1.50). Verify the 3× multiplier has
     rationale. The spec calls it "heuristic" — that's honest but is
     3× the right starting point? Note as QUESTION.

E.4  Verify NO content from the v2-deferred list (sybil scoring,
     adversarial-input hardening) sneaks into v1. MAJOR if found.

### Category F: Backward compatibility

F.1  Spec § 2.3 says "SPEC-001 does NOT change the GitHub App's
     behavior, the channel rail's pricing, or any existing receipt
     URL." Verify by reading the entire spec for any clause that
     contradicts this.

F.2  Migration 0025 backfills `payment_rail = 'channel'` for existing
     rows. Verify this is the correct default (i.e., all pre-migration
     review_jobs ARE channel-rail jobs, since x402 didn't exist).

### Category G: API stability

G.1  Receipt URL format: `antfleet.dev/receipts/{review_id}`. Verify
     this is unchanged from existing channel-rail format (OQ-4 confirms
     unified namespace).

G.2  The new optional `paid_via` field on receipts: verify any external
     consumers (Aeon, Aaron's tooling, dashboard frontend) gracefully
     handle the optional field. Note as QUESTION if uncertain about
     external consumers.

### Category H: Internal consistency

H.1  FRs contradict each other within the spec?

H.2  § 2.1 In-scope items match § 4 FRs? (Every in-scope bullet should
     have at least one FR covering it; every FR should map to an
     in-scope bullet.)

H.3  Each AC tests at least one FR? Each FR has at least one AC?

H.4  Interface contracts (§ 5) consistent with FRs (§ 4)?

H.5  Open questions (§ 10) actually open, or hand-waved decisions?
     For each OQ, can you (auditor) answer it from source materials
     (existing AntFleet code, Coinbase x402 spec, Bankr bench)? If
     yes, MAJOR finding "OQ-X is decidable from sources."

### Category I: Acceptance criteria

I.1  Each AC measurable with concrete commands/test names?

I.2  AC-1 (end-to-end happy path) actually testable in staging
     without real mainnet USDC? Or does it require mainnet? If
     mainnet-only, note as QUESTION — should there be a Base Sepolia
     analog?

I.3  AC-7 (no regression on channel rail) lists "existing channel-rail
     integration tests pass without modification" — verify those tests
     exist in the repo today.

I.4  Pass rule stated (§ 8 header: "AC-1 through AC-8 must ALL pass").
     Verify clear.

I.5  At least one AC tests the dual-rail interaction (AC-7 covers this).

### Category J: Open question discipline

J.1  Total OQ count: 5. Reasonable for v0.1.

J.2  For each OQ, can YOU answer it from public sources?
     - OQ-1 (gate token mechanism): can you decide HMAC vs JWT from
       aeon's current architecture?
     - OQ-2 (rate limit value): industry benchmarks for per-wallet
       agent invocation rate?
     - OQ-3 (per-repo cooldown): same question.
     - OQ-4 (receipt URL shape): already decided as "single namespace"
       in current position; is the OQ artificial?
     - OQ-5 (facilitator choice): Coinbase official is named as
       current position; is the OQ artificial?

     For each artificial OQ, MAJOR finding.

### Category K: Reference hygiene / clean-room

K.1  Appendix A reaffirms clean-room separation? Yes ("No proprietary
     AntFleet partner code is consulted").

K.2  Any partner-source URLs outside the clean-room block?

K.3  Bankr skills bench references: cited at "protocol-pattern level"
     only? Verify no code copied verbatim.

### Category L: Scope discipline

L.1  Bankr registry submission (deferred to v2): any spec text that
     mentions a Bankr PR or BankrBot/skills repo? MAJOR if found.

L.2  Sybil scoring / adversarial-input hardening (deferred): any
     spec text that builds toward these? MAJOR if found.

L.3  PR comment posting in x402 mode (explicitly OOS): any spec text
     that promises this? MAJOR if found.

L.4  Private repo support via x402 (OOS): MAJOR if found.

### Category M: Implementability

M.1  Could a competent Node.js backend developer build the x402
     endpoint from § 4 Part A + § 5.1 with ≤3 clarifications?

M.2  Could a competent skill developer build `run.mjs` from § 4
     Part B + § 5.2 with ≤3 clarifications?

M.3  Migration 0025 (§ 5.3): SQL syntax valid for the project's DB
     (verify against existing migrations)?

M.4  Are all new dependencies (§ 6.1) actually available on npm with
     compatible licenses?

## Severity rubric

  CRITICAL — channel-rail regression, observable API break for existing
             AntFleet consumers, refund-semantic divergence between
             rails for shared terminal states, x402 protocol mismatch
             that breaks all facilitators, undefined behavior in a
             core path, OR scope-creep into a v2-deferred capability.

  MAJOR    — ambiguous requirement with multiple valid interpretations,
             missing acceptance for a stated capability, OQ that's
             actually decidable from sources, numeric threshold without
             rationale, normative gap in error semantics, aeon-gate
             removability invariant violated, dual-rail isolation
             violated, or scope creep that doesn't break v1 but pulls
             v2-deferred work forward.

  MINOR    — formatting, wording, or default choices that cause
             friction but not failure.

  QUESTION — auditor cannot determine from source materials.

## Output format

Write to:
  /Users/augstar/projects/antfleet/specs/SPEC-001-audit.md

Structure:

  # SPEC-001 Audit Report
  Auditor: <model name + version>
  Spec audited: SPEC-001 v0.1 commit <hash>
  Audit completed: <UTC timestamp>

  ## TL;DR verdict
  READY TO BUILD | NEEDS REVISION | RESTART
  One paragraph with finding counts and the top three risks.

  ## Findings by severity

  ### CRITICAL (N)
  ### MAJOR (N)
  ### MINOR (N)
  ### QUESTIONS (N)

  Format per finding: title, severity, category (A–M), spec ref
  (e.g., "SPEC-001 § 4 Part A FR-A2"), quoted spec text, what's wrong,
  fix direction.

  ## Cross-reference resolution matrix

  Standalone table verifying each cross-reference in the spec.
  Columns:
    - Source location (spec section)
    - Reference target (file path / URL / FR ID)
    - Auditor verdict: resolves / broken / partial

  ## OQ disposition

  For each of the 5 OQs:
    - Quote the OQ
    - State whether you (auditor) can answer it from source materials
    - If yes, propose the answer + cite the source
    - If no, confirm it's a real operator decision

  ## AC coverage matrix

  Standalone table mapping each FR to the AC(s) that test it.
  FRs with no AC = MAJOR finding (capability without verification).
  ACs with no FR = MAJOR finding (test without requirement).

  ## Suggested fix order

  Ordered list of which findings should be addressed first in the
  next revision (FIX_SPEC_001_V0_1_PROMPT.md). Group CRITICALs first,
  then MAJORs that block build start, then MAJORs that block ship.

## What NOT to do

  - Do NOT modify the spec yourself. Audit only.
  - Do NOT build or scaffold code.
  - Do NOT browse proprietary partner code.
  - Do NOT propose features beyond fix direction (no scope creep
    into v0.2 design).
  - Do NOT validate by running ACs — implementation doesn't exist yet.
    Validate by reading the spec against the source code reuse claims.
  - Do NOT skip Category A (x402 protocol compliance). It is the
    primary value-add of this audit. A non-compliant x402 payload
    breaks the partnership before it starts.

When done, print a 250-word summary to stdout with:
  - Verdict
  - CRITICAL / MAJOR finding counts (broken out by category)
  - Top three risks
  - Which OQs you could answer from sources (so the operator can
    consider closing them in v0.2)
  - Whether the dual-rail isolation invariant holds (yes/no with
    one-line rationale)
  - Whether the aeon-gate removability invariant holds (yes/no with
    one-line rationale)
Then stop.

=== END PROMPT ===
```

---

## After running this prompt

Operator's review checklist:

1. Skim the **verdict** and finding counts first.
2. Read CRITICAL findings before any others. A single CRITICAL kills
   the build path until resolved.
3. Cross-check the **AC coverage matrix** — every FR should have ≥1 AC
   testing it; every AC should map to ≥1 FR. Gaps in either direction
   indicate missing requirements or missing tests.
4. Cross-check the **OQ disposition** against the spec's "current
   position" entries. If the auditor can answer an OQ from sources,
   close it in v0.2 rather than carrying it forward.

Then:
- If 0 CRITICALs and ≤5 MAJORs → write `FIX_SPEC_001_V0_1_PROMPT.md`,
  resolve, re-audit ONCE with narrower scope (only the changed sections),
  then move to `BUILD_SPEC_001_IMPL_PROMPT.md`.
- If >0 CRITICALs → write `FIX_SPEC_001_V0_1_PROMPT.md` covering them,
  re-run THIS full audit (not narrower), confirm CRITICALs cleared.
- If >10 MAJORs → consider whether the SPEC scope was wrong (e.g.,
  trying to ship too much in v1). Revisit the OUT-OF-SCOPE list and
  see if more should move there before fixing.

Expected total path: 1–2 audit rounds, then BUILD prompt. Aim to have
SPEC-001 locked within 3 days of starting the audit cycle so the
implementation can begin on schedule (~1 week of build).
