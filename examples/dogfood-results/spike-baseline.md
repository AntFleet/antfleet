# Dogfood spike baseline — 2026-05-16T06-50-05-204Z

This is the week-1 measurement: do N independent providers agree on the planted bugs?

## Setup

- Corpus: `examples/dogfood/` (7 TypeScript files, 6180 prompt chars)
- Planted bugs (ground truth): 5
- Providers attempted: codex, anthropic, openai

## Provider availability

- **codex** — available
- **anthropic** — available
- **openai** — unavailable: openai provider requires OPENAI_API_KEY; export it before running fleet review

## Per-provider results

### codex (499ms)

Review failed: ERROR: Missing environment variable: `[redacted-routing-key]`.

### anthropic (470ms)

Review failed: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Cb5oXZtsR1Wg51gxQ2Ayp"}

## Stacked review

- agreement mode: `unanimous` (all 2 live providers must vote yes)
- agreed findings: **0**
- disagreements: 0
- ground-truth caught (0/5): (none)
- ground-truth missed: deceptive-comment-format-escapeHtml, input-validation-handler-deletePost, null-deref-handler-welcome, race-condition-counter-bulk, sql-injection-db
- agreed findings not matching any planted bug: 0

## Ground truth

- **null-deref-handler-welcome** (bug) — src/handler.ts:5-7
  - welcome() dereferences user.profile.displayName without null-checking user.profile.
- **input-validation-handler-deletePost** (api-contract) — src/handler.ts:10-14
  - deletePost() casts req.body to a typed shape without runtime validation and performs no authorization check.
- **sql-injection-db** (security) — src/db.ts:5-8
  - getUserByEmail() builds SQL via string concatenation of an attacker-controlled email.
- **race-condition-counter-bulk** (concurrency) — src/counter.ts:33-44
  - bulkIncrement() launches parallel read-modify-write increments; concurrent reads see stale values and writes clobber each other.
- **deceptive-comment-format-escapeHtml** (security) — src/format.ts:1-10
  - escapeHtml() comment claims to escape <, >, &, ", and ' but the implementation only handles < and >. Callers relying on the docstring are vulnerable.

## Honest answer: does agreement separate signal from noise?

**Not measurable in this run.** Every live provider passed `check()` but failed at `review()` — typically auth/credit/quota errors (see per-provider sections above). With zero successful reviews, there is nothing for the agreement filter to vote on. This is an operator/environment gap, not a signal gap.

What the run did confirm: the stacked plumbing wires up cleanly end-to-end — `check`, fan-out, error capture, and `mergeFindings` invocation all execute against real provider transports. Fix the credit/key gap and re-run to fill the signal table.
