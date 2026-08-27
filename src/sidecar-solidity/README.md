# Whole-contract Solidity finder sidecar

Implements [`specs/SOLIDITY_SIDECAR_SPEC.md`](../../specs/SOLIDITY_SIDECAR_SPEC.md)
(§3 of the parent spec). Finding-phase only.

## What it is / is not

- **Is:** a whole-contract finder that assembles the dependency closure of an
  entry contract by REAL edges first — forward imports, full
  inheritance-implementation source (not just interfaces), and interface-typed
  addresses resolved to their concrete implementers — with the old name-regex
  reverse coupling demoted to a last-resort, evicted-first include. On `--live`
  it runs a **two-stage finder** (`run.ts`): a cheap entry-only pass surfaces
  candidates plus the cross-file definitions they depend on, then a **focused
  confirm pass** fetches exactly those named siblings (never the whole closure) —
  because a single whole-closure dump gets skimmed (measured). Findings then pass
  a gate that does NOT trust the finder's own claims:
  1. **Mechanical citation-grounding** (`scoring.ts` — no model involved): every
     cited path must exist in the assembled closure, line ranges must fall within
     real file bounds, quotes must match. Unresolvable evidence → auto-DROP.
  2. **Independent adversarial refuter** (`refuter.ts` — a SECOND model call with
     a kill-only role): a finding reaches PURSUE only if the refuter fails to
     kill it (privileged-gated, recoverable, mis-cited, out-of-scope, duplicate).
     The finder's four booleans (`unprivilegedReachable`, etc.) are advisory
     metadata only — they never gate promotion.
- **Demonstrated value (be precise):** on candidates the finder already suspects,
  the closure **raises confidence and completes the exploit chain** — its
  measured contribution, not first-detection. In the N=3 post-cutoff sweep the
  audit arm turned a low-confidence single-file suspicion into a confirmed
  CRITICAL with the full drain chain (Olas H-06). The stronger claim — "finds
  cross-file bugs a single-file slice structurally misses" — is **UNPROVEN**: 1
  confounded flip in 3 non-memorized targets (see below). Ship it as a
  confidence/chain-completion layer, not as a capability the diff-reviewer lacks.
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

# LIVE: finder (gpt-5.6-sol) + independent refuter (gpt-5.5), via OpenRouter's
# OpenAI-compatible endpoint. Needs OPENROUTER_API_KEY (or SIDECAR_API_KEY).
pnpm audit-solidity --target ... --entry ... --rules ... --live --out report.json

# Transport: OpenAI Chat Completions (json_object output) at
# https://openrouter.ai/api/v1 by default — this reaches GPT models AND Claude.
# Overrides (all optional):
#   SIDECAR_FINDER_MODEL=<id>     # stage A + stage-B confirm (default openai/gpt-5.6-sol)
#   SIDECAR_REFUTER_MODEL=<id>    # adversarial refuter        (default openai/gpt-5.5)
#   SIDECAR_MODEL=<id>            # both roles at once
#   SIDECAR_BASE_URL=<url>        # e.g. https://api.openai.com/v1 for native OpenAI
#   SIDECAR_REASONING_EFFORT=high|medium|low   (default high)
# SIDECAR_DEBUG=1 logs finish_reason + content length.
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
- Value claim is conditional on cross-file bug classes and remains UNPROVEN for
  first-detection: the post-cutoff sweep below produced no clean slice-miss →
  closure-catch win. What is demonstrated is confidence-raising / chain
  completion, not finding what a slice can't.

## Measured value — N=3 post-cutoff sweep (2026-08-27)

Three genuinely post-training-cutoff cross-file targets (published after the
model's Jan-2026 cutoff, so un-memorizable), each run as a blind slice arm (entry
file only) vs audit arm (entry + siblings), file set the only variable. Full log:
`solidity-killtest/RESULT.md`.

| Target | Slice | Audit | Closure was necessary? |
|---|---|---|---|
| Monetrix M-01 (decode drops borrow fields) | MISS | **MISS** (had the file, still skimmed past it) | no — both missed |
| Intuition M-02 (post-epoch retro-inflation) | MISS | CATCH (crit) | yes, but CONFOUNDED (deciding code in `VotingEscrow`, absent from both arms) |
| Olas H-06 (`_safeMint` callback reentrancy) | CATCH (high, low-conf) | CATCH (crit, full chain) | no — slice found it; closure upgraded it |

**0 clean wins in 3.** This drove the current design: real-edge closure (so the
deciding file is actually present — Monetrix/Intuition failures), a two-stage
finder (so a present file is actually read — Monetrix), and the honest reframe
above (Olas is the real value story). The kill-test harness now validates the
discriminating-file split per target so a future N can't repeat the Intuition
confound.

## Live e2e status (2026-08-26)

> Transport note: this run predates the transport rebuild. The sidecar now runs
> on the **OpenAI Chat Completions API via OpenRouter** (finder gpt-5.6-sol,
> refuter gpt-5.5, json_object output) — see Usage above. The Anthropic /
> forced-tool-use details below are historical.

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
