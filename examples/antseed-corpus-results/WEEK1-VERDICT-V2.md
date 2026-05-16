# Phase 0 verdict — does the 2-provider stack survive a real repo?

**Status: RED.**

Three runs of the locked v1 stack (anthropic + openai, unanimous mode) against
the real-repo corpus at `examples/antseed-corpus/`. Mean unanimous recall
against the 5 gate-verified ground-truth bugs is below the spec's RED
threshold. The signal that did surface is genuinely useful (real bugs, low
misidentification rate) but it is not the signal we measured ourselves
against. Phase 1 build is on hold pending the strategy conversation the
mission rule prescribes for RED.

## Setup

- Corpus: `examples/antseed-corpus/` (5 real-repo source files, 141,941 chars).
- Ground truth: `examples/antseed-corpus/.ground-truth.json` — 5 gate-verified bugs from a downstream codebase, none currently open as PRs. Spec also at `GROUND_TRUTH.md`.
- Stack: `anthropic` (claude-opus-4-7) + `openai` (gpt-5), unanimous mode.
- Runs: 3.
- Total estimated cost: ~$1.20 (well under the $15 mission ceiling).
- Source data: `run-1-*.md`, `run-2-*.md`, `run-3-*.md` in this directory.

## Caveat on the committed run reports

The per-run reports were generated **before** a matcher bug was caught and
fixed in this same delivery. The reports' `ground-truth caught X/5` lines
were computed against the dogfood corpus's default ground truth (e.g.,
`src/handler.ts`), not the AntSeed corpus's ground truth — so they all show
`0/5` regardless of what was actually caught. The bug is fixed in
`scripts/spike.ts` (ground truth now loads from `<corpus>/.ground-truth.json`)
and tested. **All scoring in this verdict was redone by hand** against the
correct AntSeed ground truth, using the *findings lists* in the run reports
as authoritative source data.

## Aggregated numbers (re-scored against the AntSeed ground truth)

### Per-provider findings per run

| Provider  | Run 1 | Run 2 | Run 3 | Mean | Stddev |
| --------- | ----: | ----: | ----: | ---: | -----: |
| anthropic | _failed_ | 6 | 6 | 6.0 (2 valid runs) | 0 |
| openai    | 4     | 2     | 3     | 3.0  | 1.0    |

Anthropic returned a truncated response in run 1 (`"Review failed: […"` in the
report) — a real reliability issue with the provider transport that this
verdict already counts against the stack.

### Ground-truth catches per provider per run (out of 5)

| Provider  | Run 1     | Run 2 | Run 3 | Bugs ever caught |
| --------- | --------: | ----: | ----: | ---------------- |
| anthropic | _failed_  | 2     | 1     | BUG-156, BUG-158 |
| openai    | 1         | 0     | 0     | BUG-159          |

Combined per-bug detection across all 3 runs (either provider, any agreement mode):

| Bug      | Detection rate (runs hit) |
| -------- | ------------------------- |
| BUG-018 (Electron stale pin in `package.json`)             | **0/3** |
| BUG-155 (`maxUint256` allowance in `useApproveDiem`)       | **0/3** |
| BUG-156 (bare `catch {}` in `fetchDiemPrice*`)             | **1/3** (anthropic run 2, conceptually weak overlap) |
| BUG-158 (no caching on per-render GitHub API call)         | **2/3** (anthropic runs 2 and 3, clean match) |
| BUG-159 (`Number()` precision loss in `chat.ts:750-761`)   | **1/3** (openai run 1) |

### Unanimous mode per run

| Run | Agreed findings | Ground-truth caught | Note |
| --: | --------------: | ------------------: | ---- |
| 1   | 4               | 1 (BUG-159)         | Anthropic failed; "unanimous" degraded to openai-alone (denominator 1) — not a real unanimous result. |
| 2   | 1               | 1 (BUG-156, loose)  | Both providers succeeded. Cluster covers `hooks.ts` but the agreement is on a different defect at overlapping lines (loose match). |
| 3   | 1               | 0                   | Both providers succeeded. Agreed finding is a real off-by-one in `hooks.ts:189-196` — not in ground truth. |

- Mean unanimous catches: **(1 + 1 + 0) / 3 = 0.67 / 5 = 13% recall.**
- Excluding the degraded run 1: 0.5 / 5 = 10% recall.
- Noise analysis (next section) shows the unanimous findings that did NOT match ground truth are mostly real bugs, not misidentifications.

### Alternative agreement modes (recomputed from per-run finding sets)

| Mode      | Mean agreed | Mean GT-caught | Mean noise (agreed - GT-caught) |
| --------- | ----------: | -------------: | ------------------------------: |
| unanimous | 2.0         | 0.67           | 1.33                            |
| majority  | 2.0         | 0.67           | 1.33                            |
| any       | 6.0         | 1.33           | 4.67                            |

With only 2 providers, majority requires ⌈N/2+1⌉ = 2 = unanimous; the columns
are identical. `any` (≥1 voter) sweeps in more bugs but also a lot more noise.

## Side-by-side: Week 1 (synthetic) vs Phase 0 (real repo)

| Metric (unanimous mode)              | Week 1 synthetic (3-provider) | Phase 0 real-repo (2-provider) |
| ------------------------------------ | ----------------------------: | -----------------------------: |
| Providers                            | anthropic + openai + openrouter | anthropic + openai           |
| Runs                                 | 5                             | 3                              |
| Mean GT-caught                       | 0.8 / 5 (16%)                 | 0.67 / 5 (13%)                 |
| Mean agreed findings                 | 0.8                           | 2.0                            |
| Mean noise (agreed minus GT-caught)  | 0.0                           | 1.33                           |
| Provider failures mid-run            | 0                             | 1 (anthropic, run 1 truncation) |

The Week 1 read was "unanimous degrades to the weakest voter's recall" —
diagnosed against DeepSeek-V3 as the cheap third voter. Phase 0 removed that
voter and locked the stack at two frontier peers. Recall did not recover.

The diagnosis was wrong. The weakest voter was not the bottleneck. The
bottleneck is that **two frontier models, given the same prompt, do not
consistently find the same bugs that a human reviewer would write up.** The
two models each find real bugs; the overlap between what they find is small;
the overlap between their overlap and a curated bug list is smaller still.

## Noise analysis — non-ground-truth unanimous findings

6 unanimous findings landed across the 3 runs (4 from the degraded run 1, 1
each from runs 2 and 3). Categorizing each that did NOT clean-match a
ground-truth bug:

| Run | Finding                                                                       | Category | Rationale |
| --: | ----------------------------------------------------------------------------- | -------- | --------- |
| 1   | Windows ARM64 incorrectly detected as x64 in desktop download resolver        | **(a)**  | Real arch-detection bug in `useLatestDesktopDownload.ts`; not in ground truth but a legitimate finding. |
| 1   | Mac Intel users get arm64 installer when UA-CH unavailable (Safari/Firefox)   | **(a)**  | Real arch-detection bug, adjacent to the Windows one. Genuine signal. |
| 1   | uint256 overflow risk by accepting `number` for `batchId` in write hook       | **(c)**  | Concerns the same file as BUG-155 (`useApproveDiem`/`actions.ts`) but a *different* defect (type coercion vs unlimited allowance). Real concern, ambiguous whether it should "count". |
| 2   | Token price fallback may display incorrect DIEM price (wrong asset)           | **(c)**  | Lands in `hooks.ts` (BUG-156's file). Different defect (wrong-asset, not bare-catch). Real concern, ambiguous match. |
| 3   | `usePendingAnts` excludes finalized epoch (strict `<` upper bound)            | **(a)**  | Clean off-by-one in `hooks.ts:189-196`. Real bug, outside the ground-truth window. |

Non-ground-truth breakdown:
- **(a) — real bug, bonus value:** 3 of 5 = 60%
- **(c) — ambiguous/edge-of-bug:** 2 of 5 = 40%
- **(b) — misidentification / wrong file / wrong severity:** **0 of 5 = 0%**

The signal quality of what the stack *does* agree on is high. Zero outright
misidentifications across 3 runs. The stack does not hallucinate bugs that
do not exist; it finds different real bugs than the ones a human curated.

## Verdict

Mission rule applied literally:

> **RED** — unanimous catches ≤2/5 OR adds noise vs single-provider.

Unanimous mean catch is 0.67/5 across 3 runs (best case 1/5 in the runs where
unanimous actually had 2 voters). The first OR clause fires. The verdict is
**RED**.

The second OR clause (noise) does NOT fire — unanimous is producing low-(b)
noise. But the rule is OR, not AND. RED stands.

## What this means for the MVP pitch

The "two independent frontier models must agree" pitch survives in spirit:
when both models agree, what they agree on is overwhelmingly real (0%
hallucinated, 60% bonus-real-bugs, 40% adjacent-real-concerns). But on this
corpus, **what two frontier models agree on is rarely the bug a human would
have prioritized to fix**. The agreement filter is a real-signal filter, not
a known-priority-bug filter; the pitch as written conflates the two.

Before Phase 1 ships, the human conversation needs to settle whether Antfeed
Fleet's value proposition is (a) "we find the bug you were worried about"
(this corpus says we do not, at unanimous-strictness) or (b) "we surface
fewer-but-real bugs you might not have thought to look for" (this corpus
supports that). The receipt narrative (SHA-pinned fixes) supports (b) more
naturally than (a) and may be the right pivot.

## Recommendations (for the human, NOT autopilot)

1. **Do not start Phase 1 MVP build today.** RED verdict. Mission rule: stop.
2. The matcher bug found mid-mission (corpus-specific ground truth) is a
   process lesson, not a thesis problem: every spike from here on should
   bind ground truth to corpus.
3. Anthropic's mid-run truncation in run 1 is a real reliability finding
   worth chasing: re-run 3+ baseline iterations and see whether
   `max_tokens=8192` is the cap being hit on a 142k-char prompt that
   produces a few-finding output. If so, raise to 16k.
4. Consider whether the right next experiment is:
   - **(a)** "Curate the ground truth from real PR review feedback, not from a separate gated-bug list" — measures whether the stack finds bugs a reviewer would actually flag, not bugs a reviewer would write up.
   - **(b)** "Make the spike measure precision (of agreed findings that turn out to be real) rather than recall against an external GT" — fits the actual observed strength.
   - **(c)** "Drop unanimous; ship 'majority of 2 = both agree' as the only mode and pivot pitch language to 'two-model consensus'" — same numbers, sharper framing.
5. Do not autonomously act on any of these. They are the agenda for the
   strategy conversation the RED verdict prescribes.
