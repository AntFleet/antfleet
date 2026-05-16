# Phase 0 verdict V3 — does raising `max_tokens` lift unanimous recall?

**Status: RED (deeper than V2).**

Re-ran the locked 2-provider stack (anthropic `claude-opus-4-7` + openai
`gpt-5`, unanimous mode) against `examples/antseed-corpus/` with anthropic's
`max_tokens` raised from 8192 → 16384. The reliability fix worked — zero
provider failures across 3 runs. But unanimous mean GT-catch *fell* from
0.67/5 (V2) to **0.33/5 (V3)**. The agreement set shrank from 6 findings
across 3 V2 runs to 2 findings across 3 V3 runs. Phase 1 build remains on
hold.

The V2 hypothesis ("transport truncation depressed the recall floor") is
falsified. Truncation was a real reliability bug; it was not the recall
driver.

## Setup

- Corpus: `examples/antseed-corpus/` (5 real-repo source files, 141,936 chars).
- Ground truth: `examples/antseed-corpus/.ground-truth.json` — same 5 gate-verified bugs as V2.
- Stack: identical to V2 (anthropic + openai, unanimous).
- Only change vs V2: `MAX_TOKENS` in `src/providers/anthropic.ts` (8192 → 16384). Commit message will name the V2 verdict as the reason.
- Runs: 3.
- Total estimated cost: ~$1.20 (under $3 ceiling, $15 mission ceiling).
- Source data: `run-1-2026-05-16T11-*.md`, `run-2-…`, `run-3-…` in this directory.
- Matcher bug from V2 is fixed in `scripts/spike.ts`; the auto-scored numbers in the run reports are authoritative this time, with the same generosity caveat noted below.

## Headline numbers (matcher-scored)

### Per-provider findings per run

| Provider  | Run 1 | Run 2 | Run 3 | Mean | Stddev |
| --------- | ----: | ----: | ----: | ---: | -----: |
| anthropic | 6     | 9     | 9     | 8.0  | 1.4    |
| openai    | 5     | 4     | 3     | 4.0  | 0.8    |

Both providers produced *more* output than in V2 (anthropic ~6 → 8.0, openai
~3 → 4.0). The headroom was used.

### Provider failures

| Provider  | V2 (max 8k) | V3 (max 16k) |
| --------- | ----------: | -----------: |
| anthropic | 1 (run 1 truncation) | 0 |
| openai    | 0           | 0            |

Reliability fix confirmed. The 16k bump is keep-worthy on its own merits.

### Ground-truth catches per provider per run (matcher, out of 5)

| Provider  | Run 1 | Run 2 | Run 3 | Bugs ever caught (matcher) |
| --------- | ----: | ----: | ----: | -------------------------- |
| anthropic | 2     | 1     | 2     | BUG-156, BUG-158           |
| openai    | 3     | 1     | 0     | BUG-155, BUG-158, BUG-159  |

The matcher counts file-only matches (a finding without line numbers on the
right file) and overlapping-range matches as catches even when the *defect*
is different. Hand-scoring against the actual defect (next section) tightens
this.

### Unanimous mode per run

| Run | Agreed findings | Matcher GT-caught | Hand-scored clean GT-catch |
| --: | --------------: | ----------------: | -------------------------- |
| 1   | 2               | 1 (BUG-158 loose) | 0                          |
| 2   | 0               | 0                 | 0                          |
| 3   | 0               | 0                 | 0                          |

- Matcher mean unanimous: **(1 + 0 + 0) / 3 = 0.33 / 5 = 7% recall.**
- Hand-scored clean (defect-aligned) unanimous: **0 / 15 = 0%.**

The single unanimous "catch" in run 1 is the recurring Windows ARM64 / UA-CH
arch-detection bug in `useLatestDesktopDownload.ts`. The matcher counts it
against BUG-158 because both touch the same file; BUG-158 is about *no
caching on the GitHub release fetch*, the agreed finding is about *wrong arch
string handling*. Different defect, same file. Loose.

### Alternative agreement modes (matcher-scored, recomputed from per-run sets)

| Mode      | Mean agreed | Mean GT-caught | Mean noise (agreed - GT-caught) |
| --------- | ----------: | -------------: | ------------------------------: |
| unanimous | 0.67        | 0.33           | 0.33                            |
| majority  | 0.67        | 0.33           | 0.33                            |
| any       | 10.67       | 1.67           | 9.0                             |

With 2 providers, majority ≡ unanimous, as in V2.

## Hand-scored clean catches across V3 (any provider, any run)

| Bug      | Clean catch? | Where |
| -------- | ------------ | ----- |
| BUG-018  | 0/3 | Not mentioned in any provider's output across 3 runs. The Electron-pin defect requires a `package.json` understanding the prompt does not surface. |
| BUG-155  | 0/3 | All "actions.ts" findings are about missing input validation on `parseEther`, not the `maxUint256` allowance defect. Loose file-only matches. |
| BUG-156  | 0/3 | All "hooks.ts" findings around fetchDiemPrice are about price-correctness or refresh, not the bare `catch {}` swallowing the error. Loose. |
| BUG-158  | 1/3 | Anthropic, run 3: "useLatestDesktopDownload: no shared cache; every page mount hits the GitHub unauthenticated API" — clean match on the caching defect. |
| BUG-159  | 0/3 | Findings in `chat.ts` are about retry timers, race conditions, peer lookup, and metering fetch handling — never the `Number()` precision loss on USDC bigint strings at 745-761. |

One clean catch in 15 provider-run cells. Same as V2's clean count (BUG-158
caught cleanly twice in V2 anthropic), give or take run-to-run variance —
the underlying signal isn't changing.

## Side-by-side: V2 vs V3

| Metric (unanimous mode)              | V2 (max 8k)                     | V3 (max 16k)                    |
| ------------------------------------ | ------------------------------: | ------------------------------: |
| Anthropic findings/run               | 6.0 (2 valid runs)              | 8.0                             |
| OpenAI findings/run                  | 3.0                             | 4.0                             |
| Mean agreed findings                 | 2.0                             | 0.67                            |
| Mean GT-caught (matcher)             | 0.67 / 5 (13%)                  | 0.33 / 5 (7%)                   |
| Mean GT-caught (hand-scored clean)   | 0.0 / 5                         | 0.0 / 5                         |
| Provider failures mid-run            | 1 (anthropic truncation)        | 0                               |
| Total agreed findings across 3 runs  | 6                               | 2                               |

Two effects compose:

1. **Each provider says more.** With more output budget, each model surfaces
   more candidate findings — anthropic ~+33%, openai ~+33%.
2. **The agreement set shrinks.** More findings per provider = more surface
   for the two models to disagree on. Unanimous-on-2 shrinks faster than
   per-provider noise grows, because agreement is the intersection.

V2 explained the recall floor as "two frontier models do not consistently
find the same bugs as a human reviewer." V3 sharpens that: **giving the
models more room to talk makes the intersection smaller**, not larger.
Agreement is brittle in a way more inference budget does not fix.

## Noise analysis — V3 unanimous findings

Only 2 unanimous findings landed across all 3 V3 runs (both in run 1):

| Run | Finding                                                                       | Category | Rationale |
| --: | ----------------------------------------------------------------------------- | -------- | --------- |
| 1   | Stream error handler can double-commit assistant message on retry             | **(a)**  | `chat.ts:1623-1670`. Real-looking concurrency bug outside the ground-truth window. |
| 1   | UA-CH `arm64` not recognized; Windows ARM64 mis-detected as x64               | **(a)**  | `useLatestDesktopDownload.ts:88-110`. Real arch-detection bug — the same one V2 already flagged as bonus signal. |

Breakdown:
- **(a) — real bug, bonus value:** 2 of 2 = 100%
- **(b) — misidentification / wrong file / wrong severity:** 0 of 2 = 0%
- **(c) — ambiguous edge-of-bug:** 0 of 2 = 0%

The qualitative read from V2 holds and strengthens: **the stack does not
hallucinate**. When the two frontier models agree, the thing they agree on
is consistently real (V2: 60% (a) + 40% (c) + 0% (b); V3: 100% (a) + 0% (c) +
0% (b)). The problem isn't trust-of-signal. The problem is volume-of-signal
under unanimous-on-2.

## Verdict

Mission rule (AGENTS.md §12):

> **RED** — unanimous catches ≤2/5 OR adds noise vs single-provider.

Unanimous mean catch is 0.33/5 (matcher) / 0/5 (hand-scored clean), below
both V2 and the RED threshold. The first OR clause fires more decisively
than in V2. **Verdict: RED.**

The second clause (noise vs single-provider) also reads cleaner now: agreed
findings are higher quality than single-provider noise, but there are so few
of them that "more useful per finding, fewer findings" is the right summary.

## What V3 confirms

1. **Truncation was a real reliability issue.** The V2 anthropic run-1 failure
   came back as zero failures across 3 V3 runs at 16k. Keep `MAX_TOKENS =
   16384`. Worth keeping independent of this verdict.
2. **Truncation was *not* the recall driver.** Recall did not recover. The
   problem is structural to unanimous-on-2 with two frontier peers, not to
   either provider's transport.
3. **The "two frontier models agree on real bugs" pitch is stable.** Across
   V2 + V3, zero misidentified (b)-category findings in unanimous mode. The
   signal-quality story holds.
4. **The "two frontier models agree on the *priority* bugs" pitch does not
   survive contact with real-repo data.** Clean hand-scored unanimous catches
   on the curated GT corpus: 0 in V2, 0 in V3. Six runs, zero clean catches.
   This is a strong empirical signal, not a noisy one.

## What V3 rules out as next experiments

- **Re-running V3 again** (more iterations, same prompt/stack/corpus) — V2
  + V3 already give 6 runs of stable behavior on the same corpus. Adding
  iteration 4–6 won't change the agreement-shrinks-with-more-output picture.
- **Raising `max_tokens` further** (e.g., 32k) — the limit is no longer the
  bound; we have ~8000-token outputs typical and budget for 16k. More
  budget will keep growing per-provider finding counts, which makes unanimous
  agreement *worse*, not better.
- **Adding a 3rd frontier provider for unanimous-on-3** — Week 1's data
  (`examples/dogfood-results/WEEK1-VERDICT.md`) already showed unanimous-on-3
  degrades to the weakest voter's recall. Doing it again is round-tripping.

## What V3 sharpens for the strategy conversation

The two V2-prescribed forks remain. V3 changes their relative likelihood:

- **(a) "We find the bug you were worried about"** — falsified twice. Six
  runs, zero clean catches on the curated GT corpus under unanimous-on-2.
  Pursuing this pitch requires either changing the agreement function (drop
  unanimous, move to per-category routing) or changing the ground-truth
  definition (curate from PR-review reactions, not gated-bug write-ups).
- **(b) "We surface fewer-but-real bugs you might not have thought to look
  for"** — strengthened. 100% (a)-grade real-bug signal in V3 agreement set.
  This is what the stack actually does on real repos. Aligns with the
  receipts-as-moat thesis (AGENTS.md §18.2): every receipt is provably real,
  not provably aligned with any prior expectation.

V3 also surfaces a third, narrower option not explicit in V2:

- **(d) Reframe the ground truth, keep the stack.** The curated GT corpus
  was assembled by a human writing up "bugs worth a fix PR." Two frontier
  reviewers agreeing on the same code surface a *different* class of real
  bugs — the ones reviewers notice in passing but rarely sit down to write
  up. The right benchmark may be "would a reviewer have nodded at this
  finding," not "did the stack find the items in BUGS.md." This is more
  ambitious than (a) and (b) — it changes what the spike measures, not how.

## Recommendations (for the human, NOT autopilot)

1. **Phase 1 MVP build stays blocked.** RED verdict standing for the second
   time in a row. Mission rule (AGENTS.md §12) fires.
2. **Keep `MAX_TOKENS = 16384` in `src/providers/anthropic.ts`.** Reliability
   fix is real and load-bearing for future spikes. Independent of this
   verdict.
3. **Close the truncation chase.** V3 was the right empirical step; the
   answer is no, that wasn't the bottleneck. Don't re-run V3.
4. **Take the strategy conversation now.** V2 + V3 between them give six
   runs of stable behavior. There is enough data to settle (a) vs (b) vs (d)
   without more experiments. Holding the conversation longer will not surface
   new information.
5. **If pivoting to (b) is the call:** the receipts-as-moat language in
   AGENTS.md §18.2 already supports it. Update §2 (Vision) and §15 (Brand
   and positioning) to lead with "surfaces real, high-precision findings
   you wouldn't have written up" rather than "catches the bugs you knew were
   there."
6. **If pursuing (d) is the call:** the next spike needs a new ground truth
   — not a write-up list, but a sampled "would a reviewer have nodded"
   panel. That's a meaningful corpus-construction effort, not a same-day
   experiment.

Do not autonomously act on any of these. The strategy conversation is the
gate.
