# Week 1 verdict — AntFleet stacked review

**Status: RED for unanimous mode (the configured default). STOP before Week 2.**

This aggregates 5 independent runs of the stacked review against the
planted-bug corpus under `examples/dogfood/`. Each run called all three
providers in parallel, then computed unanimous / majority / any agreement
post-hoc from the same per-provider outputs.

The verdict is the one the mission spec requires given the unanimous numbers
below. It also surfaces a strong alternative — switching the primary mode to
**majority** — which the data clearly supports. That is a human strategy
decision, not an autonomous pivot.

## Setup

- Corpus: `examples/dogfood/` (7 TypeScript files, 5 planted bugs).
- Providers: `anthropic` (claude-opus-4-7), `openai` (gpt-5), `openrouter` (deepseek/deepseek-chat — DeepSeek-V3).
- Runs: 5 (no cost-ceiling abort).
- Primary mode: `unanimous`.
- Source data: `examples/dogfood-results/run-1-*.md` through `run-5-*.md`.
- Total estimated cost across the 5 runs: **~$2.05** (well under the $5 ceiling; these are list-price estimates, not exact charges).

## Aggregated numbers

Findings emitted per provider per run:

| Provider   | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Mean | Stddev |
| ---------- | ----: | ----: | ----: | ----: | ----: | ---: | -----: |
| anthropic  |    10 |     8 |     9 |    10 |     9 |  9.2 |   0.84 |
| openai     |     7 |     6 |     6 |     7 |     7 |  6.6 |   0.55 |
| openrouter |     1 |     1 |     1 |     1 |     1 |  1.0 |   0.00 |

Ground-truth bugs caught per provider per run (out of 5):

| Provider   | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Mean | Stddev |
| ---------- | ----: | ----: | ----: | ----: | ----: | ---: | -----: |
| anthropic  |     5 |     5 |     5 |     5 |     5 |  5.0 |   0.00 |
| openai     |     5 |     4 |     5 |     5 |     5 |  4.8 |   0.45 |
| openrouter |     1 |     1 |     1 |     1 |     1 |  1.0 |   0.00 |

Stacked-agreement output (computed across all three providers each run):

| Mode      | Agreed mean | Agreed stddev | Bugs caught mean | Noise mean (agreed − ground-truth-caught) |
| --------- | ----------: | ------------: | ---------------: | ----------------------------------------: |
| unanimous |         0.8 |          0.45 |          0.8 / 5 |                                       0.0 |
| majority  |         5.0 |          0.71 |          4.4 / 5 |                                       0.6 |
| any       |        10.2 |          0.84 |          5.0 / 5 |                                       5.2 |

## Per-planted-bug detection rate

For each of the 5 planted bugs, how often did the listed mode/provider catch
it across the 5 runs:

| Bug                                   | Anthropic | OpenAI | OpenRouter | Unanimous | Majority | Any |
| ------------------------------------- | --------: | -----: | ---------: | --------: | -------: | --: |
| `null-deref-handler-welcome`          |       5/5 |    5/5 |        0/5 |       0/5 |      5/5 | 5/5 |
| `input-validation-handler-deletePost` |       5/5 |    5/5 |        0/5 |       0/5 |      5/5 | 5/5 |
| `sql-injection-db`                    |       5/5 |    5/5 |        5/5 |       4/5 |      5/5 | 5/5 |
| `race-condition-counter-bulk`         |       5/5 |    5/5 |        0/5 |       0/5 |      5/5 | 5/5 |
| `deceptive-comment-format-escapeHtml` |       5/5 |    4/5 |        0/5 |       0/5 |      2/5 | 5/5 |

Notes:

- The single unanimous miss on `sql-injection-db` (run 2) is openai narrowing its evidence to lines that did not overlap the other providers’ ranges, not a failure to spot the bug. The other 4 runs cleared unanimous threshold cleanly.
- Majority mostly tracks single-provider performance because any pair of (anthropic, openai) already gives majority. The exception is `deceptive-comment-format-escapeHtml` in 3 of 5 runs — openai and openrouter described the same finding with sufficiently different evidence ranges that `findingsAgree` did not cluster them; majority therefore degraded to "anthropic-only".

## Verdict (per the mission's spec)

> RED — unanimous catches ≤2/5 OR adds noise vs single-provider.

Unanimous catches **0.8/5 mean** (16% recall). That is RED. The mission rule
fires: STOP at this deliverable, do not auto-write the docs follow-up, surface
to a human.

The reason is structural: **unanimous degrades to the weakest provider's
recall**. DeepSeek-V3 via OpenRouter catches one bug consistently (the SQL
injection) and nothing else — so unanimous can only ever agree on that one
bug. The marketplace thesis as currently implemented ("cheap models add value
via diversity") does not survive contact with this corpus.

## Agreement-mode comparison

Same per-run finding sets, three threshold rules:

| Mode      | Recall | Noise per run | Comment                                                                    |
| --------- | -----: | ------------: | -------------------------------------------------------------------------- |
| unanimous |    16% |           0.0 | Filters everything cheap-model misses → throws baby with bathwater.        |
| majority  |    88% |           0.6 | Catches 4-5/5 with small noise. Strong signal.                             |
| any       |   100% |           5.2 | Equivalent to running anthropic+openai with their false positives stacked. |

Compared to the best single provider (anthropic: 100% recall, 4.2 noise per
run), majority is **better on noise (0.6 vs 4.2)** at a small recall cost
(88% vs 100%). Any is worse than the best single (more noise, same recall).
Unanimous is far worse on recall.

If the primary mode were `majority`, this verdict would read GREEN by every
metric in the spec. That choice is a human call, not a code change autopilot
makes on its own.

## Provider behavior notes (marketplace pitch material — for human review)

These three providers have genuinely differentiated behavior on this corpus.
Whether it adds up to a "marketplace" story is the strategy question.

**anthropic / claude-opus-4-7 — broad-net.** 9.2 findings per run, 5/5 recall
consistently, 4.2 false positives per run on average. Surfaces things the
others miss: e.g. unsafe `as` casts beyond the planted `deletePost` boundary,
process-exit-on-error patterns, missing test coverage signals. Reliable but
talky — an operator running this alone gets every bug plus a notable noise
tail. Highest cost per call.

**openai / gpt-5 — balanced.** 6.6 findings per run, 4.8/5 recall (one
deceptive-comment miss in run 2), 1.8 false positives per run. Findings
overlap heavily with anthropic on the ground-truth bugs, then diverge on the
"extra" findings. Best ratio of signal to noise of the three. Slower than
openrouter, comparable cost to anthropic.

**openrouter / deepseek/deepseek-chat — high-precision narrow.** 1 finding
per run, every run, every time it was `sql-injection-db`, every time at high
severity, every time zero false positives. Catches nothing else from the
planted set. As a "tie-breaker" or "is this the most obvious class of bug"
voter, it is fine. As a co-equal voter in unanimous mode, it is the choke
point. Cheapest by ~30× on this corpus.

The honest reading: this is a precision-vs-recall split across providers, not
a "different models catch different bugs in the same class" diversity story.
If the marketplace thesis depends on cheap models catching bugs the expensive
ones miss, we have not yet shown that — on this corpus the cheap model is
strictly a subset.

## What needs a human decision (do not autonomously act on these)

1. **Is unanimous still the brand?** The Week 1 framing was "post only findings every provider agrees on" — that produces a 16%-recall filter on this corpus. Switching the default to majority delivers the promise the README implies; it also requires owning the messaging that "agreement" no longer means "all of them".
2. **Is OpenRouter+DeepSeek-V3 the right third voter?** Same-architecture-different-vendor stacks (e.g. anthropic + openai + a second openai-compatible frontier model) might agree more often than the current price-stratified mix.
3. **Does the corpus need to expand before any of this generalizes?** Five planted bugs in seven files is not enough to draw a multi-provider conclusion. Real-world repos have orders of magnitude more findings and more disagreement surface.
4. **What does "trust substrate" mean if the moat is the SHA-pinned receipt and not the agreement filter?** Week 2 was framed as GitHub App + receipts. The agreement filter being weaker than majority does not necessarily kill the receipts thesis; it does kill the "stacked unanimous is the differentiator" narrative.

## Recommendation (for the human, not the autopilot)

- **Pause Week 2 (GitHub App + receipts) until #1 and #2 are resolved.**
- Cheap reversible experiment first: change `FLEET_STACKED_AGREEMENT=majority`
  in the spike runner, re-run the 5-iteration baseline, see whether the
  majority numbers above hold or were corpus-specific.
- If majority holds, consider whether the README and pitch need to be rewritten
  around "majority of N independent providers" rather than "all of N".
- If switching to majority feels like moving the goalpost rather than a
  legitimate calibration, that is the signal that the thesis needs a strategy
  conversation — which is exactly what RED is for.
