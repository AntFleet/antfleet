# Whole-contract Solidity finder sidecar

Implements [`specs/SOLIDITY_SIDECAR_SPEC.md`](../../specs/SOLIDITY_SIDECAR_SPEC.md)
(§3 of the parent spec). Finding-phase only.

## What it is / is not

- **Is:** a whole-contract finder that assembles the full bidirectional
  dependency closure of an entry contract (forward imports + reverse
  factory/symbol coupling), runs ONE neutral fund-extraction finder call over it,
  and promotes findings through a two-stage gate that does NOT trust the finder's
  own claims:
  1. **Mechanical citation-grounding** (`scoring.ts` — no model involved): every
     cited path must exist in the assembled closure, line ranges must fall within
     real file bounds, quotes must match. Unresolvable evidence → auto-DROP.
  2. **Independent adversarial refuter** (`refuter.ts` — a SECOND model call with
     a kill-only role): a finding reaches PURSUE only if the refuter fails to
     kill it (privileged-gated, recoverable, mis-cited, out-of-scope, duplicate).
     The finder's four booleans (`unprivilegedReachable`, etc.) are advisory
     metadata only — they never gate promotion.
- **Finds:** cross-file / cross-contract bugs the PR-diff reviewer structurally
  misses — factory/instance trust, proxy/impl splits, accounting across
  contracts. Mechanism evidence: Biconomy C4-2023-01 H-03, where the single-file
  arm structurally missed and the closure arm caught it at CRITICAL
  (`solidity-killtest/RESULT.md`; N=1 on a PRE-CUTOFF public contest —
  indistinguishable from recall, NOT evidence of capability).
- **Is NOT:** an uplift on single-file inline bugs (measured: no uplift). Not a
  verifier: nothing here executes a PoC or confirms exploitability. Not a
  submitter: bounty submission is always a human action. The parked Foundry lane
  stays parked.

## Usage

```sh
# DRY-RUN (default): assemble closure, render prompt, NO model call, no key needed.
pnpm audit-solidity \
  --target <checked-out repo dir> \
  --entry contracts/Wallet.sol \
  --rules program-rules.md

# LIVE: one finder call via model-client (needs ANTHROPIC_API_KEY).
pnpm audit-solidity --target ... --entry ... --rules ... --live --out report.json

# Routing overrides (same transport, different endpoint — useful when metered
# Anthropic credits are out; OpenRouter's Anthropic-compat route verified):
SIDECAR_BASE_URL=https://openrouter.ai/api \
SIDECAR_MODEL=anthropic/claude-sonnet-4.5 \
SIDECAR_API_KEY=$OPENROUTER_API_KEY \
pnpm audit-solidity ... --live
# SIDECAR_DEBUG=1 logs stop_reason/block-types/token usage + raw input shape.
```

Closure stats print to stderr; the prompt/report goes to stdout and `--out`.

## Honest limits

- Closure bounding can evict relevant files under budget pressure; evicted files
  are listed in every report so misses are traceable. Entries are never evicted.
- Reverse coupling heuristics (compound names like `XFactory.sol`) can
  over-include; that costs tokens, not correctness, and the budget caps it.
- Output is unverified candidate findings until each survives grounding + the
  refuter. Even then: PURSUE means "survived one adversarial pass", not
  "confirmed exploitable".
- Value claim is conditional on cross-file bug classes and UNPROVEN until a
  catch on a post-cutoff (or holdout) target — a solved-contest catch cannot be
  distinguished from memorized recall.

## Live e2e status (2026-08-26)

Verified end-to-end against the biconomy fixture via OpenRouter's
Anthropic-compat route (~$0.20 total): closure → forced-tool-use call → lenient
parse → scoring → report. Two transport defects were found and fixed BY this
e2e: (1) whole-array `.catch([])` silently discarded all findings when any
element failed parse — now per-finding salvage with loud failure when the
findings key is absent entirely; (2) some routes return `findings` as a
JSON-encoded string — normalized at the transport boundary. Result of the final
run predates the rework's refuter+grounding gate and is retained only as
pipeline evidence, not as capability evidence. Post-cutoff validation is still
outstanding (needs confirmed credits; see `solidity-killtest/RESULT.md`).
