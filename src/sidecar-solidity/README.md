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

# LIVE: stage-A finder (gpt-5.6-sol) + stage-B confirm (gpt-5.5) + independent
# refuter (gpt-5.5). NO API KEY NEEDED by default — see Transports below.
pnpm audit-solidity --target ... --entry ... --rules ... --live --out report.json

# Model overrides (apply to BOTH transports):
#   SIDECAR_FINDER_MODEL=<id>     # stage A enumerate         (default gpt-5.6-sol)
#   SIDECAR_CONFIRM_MODEL=<id>    # stage B focused confirm    (default gpt-5.5)
#   SIDECAR_REFUTER_MODEL=<id>    # adversarial refuter        (default gpt-5.5)
#   SIDECAR_MODEL=<id>            # all three roles at once
# SIDECAR_DEBUG=1 logs finish_reason / output length.
#
# WHY stage B defaults to gpt-5.5, not the finder model: on the codex/ChatGPT
# subscription, gpt-5.6-sol trips OpenAI's cyber content filter on the stage-B
# "complete this fund-extraction chain" prompt ("Trusted Access for Cyber
# program"); gpt-5.5 clears it. The enumerate-only stage-A prompt passes on 5.6.
```

### Transports

**DEFAULT — codex CLI over the ChatGPT subscription (no API key, no spend).**
`--live` shells out to `codex exec -o <tmpfile> --skip-git-repo-check -s read-only
-m <model>`, feeding the prompt over **stdin** (finder prompts reach ~200k chars,
far past any argv limit) and reading the final assistant message back out of the
temp file. Auth comes from `~/.codex` (`auth_mode: chatgpt`) — nothing is read
from `OPENAI_API_KEY`. The per-role split is unchanged: stage-A finder
`gpt-5.6-sol`, stage-B confirm `gpt-5.5`, refuter `gpt-5.5`, all passed through
`codex -m`, all overridable with the env vars above (an `openai/` vendor prefix
is stripped for the codex id spelling).
`SIDECAR_CODEX_BIN` overrides the binary path if `codex` is not on PATH.

> **codex is slow** (subscription queueing + high reasoning effort on a large
> prompt): budget many minutes per call, and a two-stage `--live` run makes
> several. It is *free*, so the trade is time-for-money — **background live
> sweeps** rather than waiting on them, and note the transport's 10-minute
> per-call ceiling.

**OPT-IN — OpenAI Chat Completions (json_object) via OpenRouter.** Select it
with either `SIDECAR_TRANSPORT=http` **or** by setting `SIDECAR_BASE_URL`; this
is the only path that costs money and the only one that needs a key.

```sh
SIDECAR_TRANSPORT=http OPENROUTER_API_KEY=... \
  pnpm audit-solidity --target ... --entry ... --rules ... --live

# HTTP-only extras:
#   SIDECAR_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY  (required)
#   SIDECAR_BASE_URL=<url>   # default https://openrouter.ai/api/v1
#   SIDECAR_REASONING_EFFORT=high|medium|low   (default high)
```

Neither transport uses API-side schema enforcement — the prompt demands strict
JSON and the downstream lenient parse absorbs the rest. The HTTP path reports a
max-tokens cut-off as `truncated: true`; codex exposes no equivalent signal, so
a cut-off there surfaces as a loud JSON parse failure instead.

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
