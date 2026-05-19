# Venice Provider Spike — Open Agent Stack Validation

**Status:** pending approval
**Mode:** direct plan (no consensus loop)
**Branch:** `spike/venice-consensus` (to be created off `main`; never pushed)
**External repo:** `antfleet/aeon-bench` (new public mirror, created in Phase -1)
**Owner:** augstar
**Date drafted:** 2026-05-18
**Revised:** 2026-05-18 — added Phase -1 (aeon-bench mirror) which resolves the R2 corpus-size mismatch by producing a real 30+ PR public benchmark
**Revised again:** 2026-05-18 (post-Phase-1 amendments, pre-Phase-2):
  - **Corpus scope: 15/30** — baseline production-app stall left 15 PRs without baseline receipts; Phase 2 runs only on the 15 with baselines (see [`webhook-queuing-fix-prompt.md`](./webhook-queuing-fix-prompt.md))
  - **Dropped dogfood supplement** — synthetic planted-bug corpus dilutes the narrative; aeon-bench only
  - **Skip baseline re-runs in Phase 2** — antfleet[bot] receipts on aeon-bench PRs ARE the baseline; harness reads them via markdown parser instead of re-calling Opus+GPT-5
  - **Model trio refined** — kept best-in-class qwen3-coder-480b; replaced stale `llama-3.3-70b` → `kimi-k2-6` (best agentic open model, trending); renamed `venice-deepseek-r1` → `venice-deepseek-v4` for slug honesty (the registered slug is already `deepseek-v4-pro`)
  - **Cost: ~$5-10 realistic** (down from $75-95 previously stated, which was double-buffered)

---

## Requirements summary

Validate whether Venice-hosted open models (Qwen 2.5 Coder 32B, DeepSeek R1, Llama 3.3 70B) can add real signal to AntFleet's unanimous-agreement gate alongside Claude Opus 4.7 and GPT-5. The output is a publishable lab artifact regardless of outcome (GOOD / MIXED / BAD), with pre-registered methodology committed *before* any code lands.

---

## Codebase reality check (read before reviewing)

The brief contains three assumptions that don't match the current codebase. The plan resolves each one; please confirm the resolutions before approval.

### R1 — Wiring target is wrong

> Brief: "Wire the new provider into `src/providers/stacked.ts`."

`src/providers/stacked.ts:11-153` is a **pure composition primitive** (`stackedProvider({ providers, agreement })`) that takes an array of `Provider` objects at call-time. It contains no provider registry.

The actual name→implementation lookup is `src/provider.ts:32-49` `providerByName(name)`. This is what the spike runner calls (`scripts/spike.ts:189`). **Venice must be registered there.** No change to `stacked.ts` is needed.

### R2 — Corpus shape ≠ "PRs" — RESOLVED by Phase -1

> Brief: "minimum 30 PRs … per-PR raw findings … cost_per_agreed_finding … marginal_contribution per 10 PRs."

**Original problem:** the in-repo corpora are single trees, not PRs. `examples/dogfood/` is one planted-bug TypeScript tree with **5 ground-truth bugs** (`scripts/spike.ts:82-126`). `examples/antseed-corpus/` has 3 sub-apps. The existing `scripts/spike.ts` reviews one corpus per invocation; it does not iterate over PRs. The only public antfleet-org PR-shaped benchmark today is `antfleet/agent-autonomopoly-bench` with 4 PRs.

**Resolution (Phase -1):** build a new public mirror `antfleet/aeon-bench` of `aaronjmars/aeon` (366 stars, MIT-licensed, 179 merged PRs, TypeScript-primary, active daily, already Venice-aware via VVV skills). Cherry-pick 30+ PRs across categories using the same replay convention `agent-autonomopoly-bench` already uses. This produces real PR diffs with public per-PR receipts and lets the brief's **original** per-PR metric definitions stand without adaptation. Phase -1 details are in the Implementation Steps section below.

| Brief term | Definition (post Phase -1) |
|---|---|
| "per PR" | one bench-repo PR, reviewed as its diff against the mirror's main |
| "≥30 PRs" | ≥30 cherry-picked PRs in `antfleet/aeon-bench`, mix of feature/fix/security/chore |
| `frontier_recall` | per PR: % of baseline (Opus+GPT-5 unanimous) findings the Venice model also flags |
| `venice_precision` | per PR: % of Venice-only findings rated "real" by manual review (sampled from `marginal-contribution-shortlist.md`) |
| `marginal_contribution` | count of real bugs caught only because Venice was in the fleet, summed across all PRs |
| `cost_per_agreed_finding` | Σ(per-call USD from `src/spike/cost.ts`) ÷ agreed-finding count, per Venice model |

**Corpus scope (post-decision 2026-05-18):** aeon-bench only. The earlier plan included `examples/dogfood/` as a ground-truth-labeled supplement for automated precision; dropped because the brief explicitly targets aeon as the corpus, and synthetic-planted-bug data dilutes the narrative. All precision is manually rated from the marginal-contribution shortlist.

**Decision gates (per-PR, original brief thresholds, rescaled to 15-PR corpus):**
- **GOOD:** any Venice model achieves ≥60% frontier_recall (averaged across PRs) AND ≥2 marginal_contribution across the 15-PR corpus (= ≥1 per 10 PRs at the brief's original rate, rounded up for the smaller sample)
- **MIXED:** 40–60% recall with non-zero marginal_contribution
- **BAD:** <40% recall AND ≈0 marginal_contribution

**Corpus reduction note (2026-05-18, post-Phase-1 amendment):** the bench has 30 replay PRs but only 15 received baseline reviews from the production AntFleet GitHub App during the initial burst (rate-limit-like stall, root cause analysis in [`webhook-queuing-fix-prompt.md`](./webhook-queuing-fix-prompt.md)). Phase 2 scopes to the 15 with baselines because the others can't yield `frontier_recall` data. The pre-registered SPIKE.md (commit `b122a13`) names 30; the Phase 4 writeup must disclose the actual corpus = 15 with the stall as the reason. Security-PR coverage in the 15 is intact (all 5 security replays got baselines); feature/cross-cutting coverage is thinner.

**Why aeon-bench, not just letting the GitHub App auto-review the PRs:** the production AntFleet GitHub App uses the anthropic+openai stacked provider only. To evaluate Venice as a third reviewer, the spike needs its own per-PR harness that pulls each PR's diff and runs the local provider stack including Venice. The bench mirror produces the public receipts (anthropic+openai baseline, posted by the GitHub App); the spike harness produces the comparison data with Venice added.

### R3 — Mirror `openrouter.ts`, not `openai.ts`

`src/providers/openai.ts` uses OpenAI strict `response_format: { type: "json_schema", schema, strict: true }`. Venice-hosted open models almost certainly **don't** honor that mode (this is exactly why `openrouter.ts:82-122` falls back to `response_format: { type: "json_object" }` with the schema embedded in the system prompt, plus a fence-stripping parser at `openrouter.ts:171-178`).

**Resolution:** `src/providers/venice.ts` is a near-copy of `openrouter.ts` with:
- `BASE_URL = "https://api.venice.ai/api/v1"`
- env key `VENICE_API_KEY`
- no `HTTP-Referer` / `X-Title` headers (those are OpenRouter-specific)
- default model parameterized via a factory: `makeVeniceProvider(defaultModel: string, name: string): Provider`

---

## Acceptance criteria (testable)

1. **Phase -1:** `antfleet/aeon-bench` exists, public, with `BENCHMARK.md` matching the agent-autonomopoly-bench template (includes "not maintained" + "to stop being benchmarked open an issue" disclaimers).
2. **Phase -1:** `gh pr list --repo antfleet/aeon-bench --state open --json number | jq length` returns ≥30. Each PR has the `(replay of <sha>)` title suffix.
3. **Phase -1:** `.spike/venice-2026-05/pr-shortlist.json` exists with ≥30 entries, each containing `{upstream_pr, upstream_sha, category, expected_signal}`. Categories include security (≥5), feature (≥10), chore/dependabot (≥5), cross-cutting fixes (≥5).
4. **Phase -1:** every aeon-bench PR has an `antfleet[bot]` review comment (the production-app baseline). Verified by `gh api repos/antfleet/aeon-bench/issues/<N>/comments --jq '.[] | select(.user.login=="antfleet[bot]")'` returning ≥1 result per PR.
5. **Phase -1:** `.spike/venice-2026-05/baseline-aeon-bench.json` exists with one entry per PR.
6. **Phase 0:** `SPIKE.md` exists at antfleet repo root and is the **first** commit on `spike/venice-consensus` (verified by `git log --reverse spike/venice-consensus ^main --oneline` showing the SPIKE.md commit at position 1). SPIKE.md references the pr-shortlist.json SHA from Phase -1.
7. **Phase 1:** `src/providers/venice.ts` exists, exports `makeVeniceProvider(defaultModel, name)`, registered in `src/provider.ts:providerByName` under `venice-qwen-coder`, `venice-deepseek-r1`, `venice-llama-70b`.
8. **Phase 1:** `src/providers/venice.test.ts` exists, mocks the HTTP layer, and verifies: (a) `check()` throws `FleetError` with `/VENICE_API_KEY/` when key missing; (b) `check()` returns a ready string when key set; (c) `extractVeniceContent()` parses a recorded chat completion through `reviewOutputSchema`; (d) throws on empty content; (e) throws on invalid JSON; (f) strips a `\`\`\`json … \`\`\`` fence.
9. **Phase 1:** `pnpm test && pnpm typecheck && pnpm lint` all exit 0.
10. **Phase 1:** `.env.example` contains `VENICE_API_KEY=` and `VENICE_FALLBACK_MODEL=`.
11. **Phase 1:** `pnpm spike` accepts the three venice provider names as valid `--providers` entries.
12. **Phase 2:** `scripts/spike-per-pr.ts` exists; `pnpm spike-per-pr` script wired in package.json. It enforces the $200 cumulative ceiling and writes per-PR-per-config JSON to `.spike/venice-2026-05/aeon-bench/`.
13. **Phase 2:** all baseline-eligible PRs (15 as of 2026-05-18, more if baseline trickle continues) × 3 Venice models have JSON output in `.spike/venice-2026-05/aeon-bench/` (≥45 files at N=15). The harness logged its actual N at startup and N matches the file count. No dogfood files. No baseline re-run files.
14. **Phase 3:** `scripts/analyze-venice-spike.ts` produces `SPIKE_RESULTS.md` (metric table, verdict, total spend), `spike-intersection.json` (Venn data), `marginal-contribution-shortlist.md` (5 best Venice-only-or-Venice+1 candidates).
15. **Phase 4:** `BLOG_DRAFT_open_agent_stack.md` exists, 1500–2500 words, references SPIKE.md commit SHA, contains the conclusion variant matching the verdict.
16. No commit on `spike/venice-consensus` contains a live Venice key (verified by `git log -p spike/venice-consensus ^main | grep -E 'VENICE_API_KEY=[^[:space:]]+' | grep -v '^\+VENICE_API_KEY=$'` returning empty).
17. `spike/venice-consensus` was never pushed (`git branch -r | grep spike/venice-consensus` returns empty). The aeon-bench mirror IS pushed (it's a separate public repo, not a branch on antfleet).
18. Final handoff: branch name, total estimated USD spend, verdict, path to draft writeup, one-paragraph data summary, link to aeon-bench repo.

---

## Implementation steps

### Phase -1 — Build aeon-bench mirror (external, public)

**Goal:** create `antfleet/aeon-bench` with 30+ cherry-picked PRs replayed from `aaronjmars/aeon`, mirroring the proven `agent-autonomopoly-bench` convention. This is the corpus the spike will evaluate against.

**Why this work happens first:** the spike's pre-registration in `SPIKE.md` (Phase 0) needs to name the exact PR set being evaluated and link to the bench repo. Building the bench after pre-registering would be backwards.

**Step -1.0 — Verify GitHub identity (BLOCKING — runs before any write).** AntFleet writes must go through `antfleet-ops`, not the operator's personal `Augustas11` account.
- `gh auth status` → confirm active account line shows `antfleet-ops`. If it shows `Augustas11`, run `gh auth switch --user antfleet-ops` and re-verify.
- Set the antfleet-repo commit identity so commits LINK to the antfleet-ops GitHub user (verified id 285575208). The `ops@antfleet.dev` address used in some legacy bench-repo commits is NOT linked to any GitHub user — use the noreply email instead:
  ```bash
  git -C /Users/augstar/projects/antfleet config user.name "antfleet-ops"
  git -C /Users/augstar/projects/antfleet config user.email "285575208+antfleet-ops@users.noreply.github.com"
  ```
- For the bench-repo clone (when checking it out for replays), apply the same `user.name`/`user.email` config so cherry-picked commits and the BENCHMARK.md commit carry the linked-to-GitHub operator identity. Note: cherry-picks preserve the **author** of the original upstream commit (correct — that's the whole point of replay attribution); the local antfleet-ops identity applies to the **committer** field and to any new commits like BENCHMARK.md.
- If `gh auth switch --user antfleet-ops` fails (account not in keyring), STOP and ask the user — do not proceed under the personal account.

**Step -1.1 — Fork aeon into antfleet org.** `gh repo fork aaronjmars/aeon --org antfleet --fork-name aeon-bench --clone=false --default-branch-only`. This matches the existing convention (`antfleet/agent-autonomopoly-bench` is also a true fork of `Liquid-Protocol-Ops/agent-autonomopoly`). The AntFleet GitHub App (org install ID 133030324, `repository_selection: "all"`) automatically covers any new repo or fork in the antfleet org — no per-repo install step needed. Then add a `BENCHMARK.md` modeled exactly on `antfleet/agent-autonomopoly-bench/BENCHMARK.md` (fetch via `gh api repos/antfleet/agent-autonomopoly-bench/contents/BENCHMARK.md` for the template; preserve the "not maintained" + "not affiliated" disclaimers and the "to stop being benchmarked, open an issue on antfleet/antfleet" opt-out line).

**Step -1.2 — Pick the PR shortlist (30 PRs).** Cherry-pick from `aaronjmars/aeon`'s 162 merged PRs across these categories for reviewer-breadth coverage:
- 5 security/hardening: must include **#158** (`fix(dashboard/skills/run): use execFileSync to harden against shell injection`); find 4 more via `gh pr list --repo aaronjmars/aeon --search "security OR injection OR sanitize OR escape OR vulnerab"`
- 10 feature PRs across subsystems: skills, dashboard, CI. Candidates from recent activity: #180 (VVVKernel Venice — extra resonance for the spike), #179, #176, #175, #168, #165, #162, #160, #157, #152
- 5 dependabot/chore PRs (calibration anchors — expected ≈0 findings; tests false-positive rate)
- 5-10 cross-cutting fixes including the recurring `-R repo` series (#167, #169, #178) which gives the reviewers a chance to flag the repeated pattern

Persist the final shortlist as `.spike/venice-2026-05/pr-shortlist.json` with `[{ upstream_pr, upstream_sha, category, expected_signal }]` BEFORE Phase 0 commits, so SPIKE.md can reference it.

**Step -1.3 — Replay each PR.** For each entry in the shortlist, mirror the replay procedure from `agent-autonomopoly-bench/BENCHMARK.md`:
```bash
git fetch upstream <upstream-sha>
git checkout -b bench/<short-sha> <upstream-sha>^   # branch from parent
git cherry-pick <upstream-sha>
git push origin bench/<short-sha>
gh pr create --title "<original title> (replay of <short-sha>)" --body "$(cat <<EOF
## Benchmark replay
This PR replays upstream commit [\`<sha>\`](https://github.com/aaronjmars/aeon/commit/<sha>) ("<original title>") as a diff against its parent.
**Not for merge.** Purpose: AntFleet two-model PR review evaluation.
See [BENCHMARK.md](../blob/main/BENCHMARK.md).
EOF
)"
```
Automate via a script (`scripts/build-aeon-bench.sh`) so the replay is reproducible. The script must be idempotent (skip if branch exists, skip if PR exists).

**Step -1.4 — Let the production AntFleet GitHub App review each replay PR.** The AntFleet App is already org-wide on antfleet (verified: install 133030324, `repository_selection: "all"`), so no install action is needed — `antfleet[bot]` will post review comments automatically. Wait for it to complete on all 30 PRs — this is the baseline (anthropic+openai unanimous). Verify on `antfleet.dev/receipts` that the count increases.

**Step -1.5 — Snapshot baseline.** Pull all baseline review comments via `gh api repos/antfleet/aeon-bench/issues/<N>/comments` for each PR; persist to `.spike/venice-2026-05/baseline-aeon-bench.json` with `{ pr_number, baseline_findings: [...], review_sha, models_used, cost_estimate }`. This is the baseline the spike's three-way runs compare against.

**Step -1.6 — Acceptance check.** Confirm: bench repo exists public, has ≥30 open replay PRs, `BENCHMARK.md` is present with the standard disclaimer, all 30 PRs have an `antfleet[bot]` review comment, baseline JSON exists. No spike code has been written yet.

**Outreach note (out of scope, flagged for follow-up):** the aeon project's tagline is "no approval loops, no babysitting" — philosophically opposed to gated review. Lead any outreach with the "low-noise, only flags real consensus" framing. The receipts themselves will sell better than any pitch.

### Phase 0 — Pre-register methodology (no code yet)

**Step 0.1 — Verify Venice model IDs.** Before drafting SPIKE.md, fetch `https://api.venice.ai/api/v1/models` (publicly accessible, no key required for the catalog) and confirm the exact Venice slug for each candidate. The brief uses `qwen-2.5-coder-32b`, `deepseek-r1`, `llama-3.3-70b`; Venice may use `qwen-2.5-coder-32b`, `deepseek-coder-v2-instruct`, `llama-3.3-70b-instruct` or different. Record the exact slugs used in SPIKE.md so the pre-registration is reproducible. **If Venice does not host one of the three model families, document the substitution in SPIKE.md before committing** — the pre-registration must reflect what was actually tested.

**Step 0.2 — Branch.** `git checkout -b spike/venice-consensus`. Confirm `main` is the upstream.

**Step 0.3 — Write `SPIKE.md`** at repo root containing:
- Goal (one paragraph, lifted from brief)
- Models under test (with verified Venice slugs from 0.1)
- Corpus statement: the 30 cherry-picked PRs in `antfleet/aeon-bench` (link to repo + commit-pinned `pr-shortlist.json` SHA from Phase -1) as the primary corpus, plus `examples/dogfood/` as the ground-truth-labeled supplement (5 planted bugs at `scripts/spike.ts:82-126`)
- Metric definitions (the four metrics from the brief, per-PR definitions)
- Decision gates: GOOD ≥60% recall + ≥1 marginal/10 PRs / MIXED 40-60% / BAD <40% & ≈0 marginal
- Cost cap: $200 hard ceiling via `--ceiling 200`
- Cancellation policy: stop and report after 2 consecutive identical errors in any phase

**Step 0.4 — Commit.** `git add SPIKE.md && git commit -m "chore(spike): pre-register Venice consensus spike methodology"`.

**Step 0.5 — Verify ordering.** `git log --reverse spike/venice-consensus ^main --oneline` must show the SPIKE.md commit at line 1. If not, stop — something is wrong.

### Phase 1 — Venice provider

**Step 1.1 — Add `.env.example` entries** (`apps/web/.env.example` if web, repo-root `.env.example` actually exists):
```
VENICE_API_KEY=
VENICE_FALLBACK_MODEL=
```

**Step 1.2 — Create `src/providers/venice.ts`.** Copy `src/providers/openrouter.ts` and adapt:
- `BASE_URL = "https://api.venice.ai/api/v1"`
- Remove `HTTP_REFERER`, `X_TITLE`, the `defaultHeaders` block
- env key `VENICE_API_KEY`, fallback env `VENICE_FALLBACK_MODEL`
- Export a factory `makeVeniceProvider(defaultModel: string, name: string): Provider` so each named provider carries its own `name` and `defaultModel`. Keep the same 3-attempt retry policy.
- Export `extractVeniceContent` for tests (mirror `extractOpenRouterContent`).

**Step 1.3 — Register in `src/provider.ts`.** Add the import and three named branches to `providerByName`:
```ts
import { makeVeniceProvider } from "./providers/venice.js";
// ...
if (name === "venice-qwen-coder") return makeVeniceProvider("qwen-2.5-coder-32b", "venice-qwen-coder");
if (name === "venice-deepseek-r1") return makeVeniceProvider("deepseek-r1", "venice-deepseek-r1");
if (name === "venice-llama-70b")  return makeVeniceProvider("llama-3.3-70b", "venice-llama-70b");
```
Substitute the verified slugs from Step 0.1.

**Step 1.4 — Add cost estimates to `src/spike/cost.ts`** (the brief forbids changes to `anthropic.ts`/`openai.ts` but not to cost.ts, and per-call cost is a hard requirement for `cost_per_agreed_finding`). Use Venice's published per-MTok prices; if not yet listed, use OpenRouter's price for the equivalent model as a stand-in and document the substitution. Approximate per-call:
```ts
"venice-qwen-coder": 0.02,    // ~$0.50/MTok in, $1.50/MTok out × ~6k/2k chars
"venice-deepseek-r1": 0.05,   // R1 is reasoning-heavy; conservative
"venice-llama-70b": 0.03,
```
Real-world calibration happens in Phase 2 from the actual token counts.

**Step 1.5 — Tests.** Create `src/providers/venice.test.ts` and `src/providers/__fixtures__/venice-review-with-findings.json`, `venice-review-malformed.json`, `venice-review-fenced.json`. Mirror `src/providers/openai.test.ts:1-95` structure. Critical extra case: a fixture with a JSON response wrapped in `\`\`\`json … \`\`\`` to verify the fence-stripping path.

**Step 1.6 — Green build.** `pnpm test && pnpm typecheck && pnpm lint`. If anything fails, fix before proceeding. Do not commit failing code.

**Step 1.7 — Commit.** `git commit -m "feat(providers): add venice (open-model fleet) provider"`.

### Phase 2 — Spike execution

**Step 2.0 — Phase 1 amendments (commit on `spike/venice-consensus` before harness work).**
- Rename provider `venice-llama-70b` → `venice-kimi-k2` in `src/provider.ts:providerByName` (slug: `kimi-k2-6`)
- Rename provider `venice-deepseek-r1` → `venice-deepseek-v4` in `src/provider.ts:providerByName` (slug stays `deepseek-v4-pro`, just label honesty)
- Update `src/spike/cost.ts`: drop `venice-llama-70b` entry, add `venice-kimi-k2: 0.05` (Kimi K2 pricing on Venice; calibrate after first call), rename `venice-deepseek-r1` → `venice-deepseek-v4`
- Run `pnpm test && pnpm typecheck && pnpm lint` — must stay green
- Commit: `chore(providers): refine venice trio — drop stale llama-3.3, add kimi-k2, rename deepseek-v4`
- **SPIKE.md amendment commit** documenting the rename: pre-registration honesty allows refining BEFORE execution as long as it's disclosed and the gates don't move (gates are unchanged). Commit: `chore(spike): amend pre-registration — refine venice trio to qwen-coder/kimi-k2/deepseek-v4`

**Step 2.1 — Smoke-test the two new models** (~$0.05 each):
```bash
pnpm spike --providers venice-kimi-k2 --runs 1 --corpus examples/dogfood --ceiling 1
pnpm spike --providers venice-deepseek-v4 --runs 1 --corpus examples/dogfood --ceiling 1
```
Confirm: provider ready, Venice catalog accepts the slug, response parses through Zod schemas. If either errors on slug-not-found, check Venice catalog and substitute (e.g., `kimi-k2-5` if `k2-6` is gone).

**Step 2.2 — Build the per-PR Venice harness.** Simpler than the prior plan version because **we skip frontier re-runs entirely** — the published `antfleet[bot]` receipts on each aeon-bench PR ARE the baseline. Create `scripts/spike-per-pr.ts` that:
1. Reads `.spike/venice-2026-05/pr-shortlist.json` and `.spike/venice-2026-05/baseline-aeon-bench.json`
2. **Filters to PRs with completed baseline receipts.** Skip any PR with no `antfleet[bot]` comment in the baseline snapshot. Print `[spike-per-pr] running against N/30 PRs with baselines` at startup. Refuse to run if N < 10; prompt to re-snapshot.
3. **Parses each baseline antfleet[bot] comment markdown into structured findings.** Format is consistent (see PR #3 example: `**<Category> · <Severity>** — <title>\n\`<path>:<lines>\`\n\n> <quote>`). Helper `parseBaselineFinding(commentBody): Finding[]` — ~30 lines of regex + line-range parsing. Unit tested with 3-5 real comment fixtures.
4. For each filtered PR: fetch head SHA from `antfleet/aeon-bench`, materialize a temp working tree of *only the files touched by that PR* (`gh pr diff <N> --repo antfleet/aeon-bench --name-only` + copy from shallow clone at head).
5. For each of the **3 Venice models** (qwen-coder, kimi-k2, deepseek-v4), call the Venice provider's `review()` directly on the mini-corpus.
6. Persist per-PR-per-venice-model JSON to `.spike/venice-2026-05/aeon-bench/pr-<N>-<model>.json` containing: raw `ReviewOutput`, parsed baseline findings, computed `frontier_recall` (= |baseline ∩ venice_findings| / |baseline|), venice-only findings list.
7. Enforces the $200 cumulative cost ceiling from `src/spike/cost.ts:51-69`. With $5-10 realistic spend, this is trivially satisfied.

This is ~120-150 lines of new TS (smaller than the prior version because no stackedProvider invocation, no frontier calls). It shares the `Provider` type and `providerByName` factory; no changes to `src/provider.ts` beyond Step 2.0.

**Step 2.3 — Per-PR harness smoke test** (~$0.15): run the new harness on a single PR with all 3 Venice models to confirm baseline parsing + per-model JSON output:
```bash
pnpm spike-per-pr --shortlist .spike/venice-2026-05/pr-shortlist.json --limit 1 --models all
```
Inspect the resulting JSON to confirm: baseline parsed cleanly (findings list non-empty for that PR), all 3 Venice models returned valid `ReviewOutput`, `frontier_recall` computed.

**Step 2.4 — Full execution.**
- **Pre-step:** refresh baseline snapshot — `bash scripts/snapshot-aeon-bench-baseline.sh`. The current snapshot captures 15/30; if more have trickled in since, the harness automatically picks them up. Commit the refreshed JSON.
- **Primary:** `pnpm spike-per-pr --shortlist .spike/venice-2026-05/pr-shortlist.json --models all`. Runs on whatever N PRs currently have baselines (15 minimum) × 3 Venice models. Output → `.spike/venice-2026-05/aeon-bench/`. Expected count at N=15: **45 JSON files** (one per PR per Venice model). Estimated spend: **~$5-10** ($0.02-0.10 per Venice call × 45, depending on PR size, retries).
- **No supplement runs.** Dogfood dropped. All metrics computed from aeon-bench data only.

**Step 2.5 — Error policy.** `stackedProvider` already degrades gracefully on per-provider error (`src/providers/stacked.ts:48-83`). Venice errors are captured per-call in the per-PR JSON. The 3-attempt retry+fallback in `venice.ts` (mirrored from openrouter) meets the brief's "max 3 attempts per call" requirement.

**Step 2.6 — Cost guard.** Per-PR harness must check cumulative spend against $200 before starting each PR × config call (mirror the logic in `src/spike/cost.ts:51-69`). If aborted, report current spend and the PRs completed.

### Phase 3 — Analysis

**Step 3.1 — Write `scripts/analyze-venice-spike.ts`.** Pure TypeScript, runs via `tsx`. Inputs: `.spike/venice-2026-05/aeon-bench/` (per-PR-per-venice-model data) + `.spike/venice-2026-05/baseline-aeon-bench.json` (production-app receipts = the baseline). Outputs: `SPIKE_RESULTS.md`, `spike-intersection.json`, `marginal-contribution-shortlist.md`.

Computes, per Venice model:
- `frontier_recall`: per PR, the fraction of baseline (Opus+GPT-5 unanimous) findings the Venice model also flags. Finding identity matched via `category + first-evidence-path + start-line bucket` (titles vary). Averaged across the N PRs (≥15). Each PR's recall is already pre-computed by the harness; analyzer just averages.
- `venice_precision`: aeon-bench has no labeled ground truth; precision is computed from a manual rating pass. Analyzer collects all Venice-only findings (Venice flagged, baseline didn't), ranks by category severity, takes top 20, writes them to `marginal-contribution-shortlist.md` with explicit "rate as real/false-positive" markers. After human pass, re-run analyzer with `--ratings ratings.json` and it reports `venice_precision_sampled = <real> / <total>`.
- `marginal_contribution`: count of distinct Venice-only findings rated "real" in the manual pass.
- `cost_per_agreed_finding`: Σ(per-call USD from `src/spike/cost.ts`) ÷ agreed-finding count, per Venice model. Note: baseline cost is sunk (already paid in Phase -1), so this is incremental cost per finding Venice contributes.

**Step 3.2 — Verdict.** Compare each Venice model's metrics to the pre-registered gates from SPIKE.md. Write `SPIKE_RESULTS.md` with: per-model metric table, intersection counts, the verdict line `**Verdict: GOOD | MIXED | BAD**` with the specific numbers that justify it.

**Step 3.3 — Shortlist.** Pick the 5 most interesting "Venice-only that matched ground truth OR looks-real-on-inspection" findings; render them anonymized (no raw corpus filenames if they aren't already public — they are, all the corpora are in-repo, so paths are fine). Persist to `.spike/venice-2026-05/marginal-contribution-shortlist.md` for human review.

**Step 3.4 — Commit.** `git commit -m "chore(spike): venice spike results + analysis"`.

### Phase 4 — Draft writeup

**Step 4.1 — `BLOG_DRAFT_open_agent_stack.md`.** Word count 1500–2500. Structure from brief. Source the SPIKE.md SHA via `git log --reverse -1 --format=%H -- SPIKE.md`.

For the **Implications** section, embed all three swap-in variants commented out, then uncomment the one matching the verdict:
```markdown
<!-- GOOD: "Open-model agreement is real — Venice's <model> caught X% of frontier consensus
     plus N marginal bugs neither frontier caught. This unlocks…" -->
<!-- MIXED: "Open models contribute, but inconsistently. The marginal_contribution exists but
     the recall variance suggests…" -->
<!-- BAD: "Frontier consensus dominates. Open models in this configuration didn't add signal,
     they added noise. The most likely reasons are…" -->
```

**Step 4.2 — Do NOT publish.** Leave for human review. Commit as draft: `git commit -m "docs(spike): draft open-agent-stack writeup"`.

---

## Risks and mitigations

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| 1 | Venice model slugs in the brief don't match Venice's actual catalog | High | Step 0.1 verifies the catalog *before* commitment; SPIKE.md records the slugs actually used |
| 2 | Venice rejects `response_format: json_object` (some hosts ignore it) | Medium | Mirror `openrouter.ts`'s system-prompt-embedded schema; the fence-stripping parser handles models that wrap JSON in code fences |
| 3 | Per-PR ground truth in aeon-bench requires manual rating (no labels exist upstream) | High | `marginal-contribution-shortlist.md` flags the candidates; user does a human pass before the verdict is finalized. Dogfood's 5 labeled bugs serve as the automated precision anchor. |
| 3b | Building 30+ replay PRs in a new public mirror creates noise for aaronjmars (notifications via cross-repo references) | Medium | The replays don't link to upstream PRs in their body — only to the upstream commit SHAs (no cross-PR reference). The BENCHMARK.md disclaimer + opt-out instructions are present. Stop creating new replays immediately if upstream objects. |
| 4 | Live spend exceeds $200 cap | Low | `--ceiling 200` aborts before any run that would exceed; per-run cost is logged each iteration |
| 5 | Accidental commit of `VENICE_API_KEY` | Medium | Only `.env.example` is edited; `.env.local` is gitignored; acceptance criterion #12 grep-checks before handoff |
| 6 | Accidental push of `spike/venice-consensus` to GitHub | Low | Plan explicitly says no push, no PR; acceptance criterion #13 checks |
| 7 | Pre-registration commit ordering breaks (e.g., adding venice.ts before SPIKE.md) | Medium | Phase ordering is enforced; Step 0.5 verifies via `git log --reverse` before any provider code is written |
| 8 | Brief says "wire into stacked.ts" but reality is `provider.ts` — reviewer flags it as deviation | Low | R1 explanation above; provider.ts:32-49 is the actual registry |
| 9 | Anonymization rules: corpus paths/contents in spike artifacts | Low | Both `examples/dogfood/` and `examples/antseed-corpus/` are in-repo and public; no customer PR data is touched |
| 10 | Venice returns rate-limit errors mid-run, all 5 runs error out before getting useful data | Medium | The 3-attempt retry in venice.ts handles transient errors; persistent failures mark the run as `venice_error` and the analyzer reports degraded coverage instead of failing |

---

## Verification steps (definition-of-done checklist)

Before final handoff, **verify each item explicitly:**

1. `gh pr list --repo antfleet/aeon-bench --state open --json number | jq length` returns ≥30
2. `gh api repos/antfleet/aeon-bench/contents/BENCHMARK.md --jq '.content' | base64 -d | grep -q "to stop being benchmarked"` exits 0
3. For each PR N in 1..max: `gh api repos/antfleet/aeon-bench/issues/N/comments --jq '[.[] | select(.user.login=="antfleet[bot]")] | length' >= 1`
4. `git log --reverse spike/venice-consensus ^main --oneline | head -1` shows the SPIKE.md commit
5. `git log -p spike/venice-consensus ^main | grep -E 'VENICE_API_KEY=[^[:space:]]+'` returns empty
6. `git branch -r | grep spike/venice-consensus` returns empty (no push)
7. `pnpm test && pnpm typecheck && pnpm lint` all exit 0
8. `ls .spike/venice-2026-05/aeon-bench/ | wc -l` returns ≥120 (30 PRs × 4 configs)
9. `ls .spike/venice-2026-05/dogfood/ | wc -l` returns ≥20 (4 configs × 5 runs)
10. `SPIKE_RESULTS.md` exists at antfleet repo root, contains literal `**Verdict:` followed by `GOOD`, `MIXED`, or `BAD`
11. `wc -w BLOG_DRAFT_open_agent_stack.md` returns 1500–2500
12. The chosen Implications variant in the blog draft matches the verdict in SPIKE_RESULTS.md
13. Total spend (sum across all per-PR-per-config JSON `estimatedCostUsd`) ≤ $200, reported in handoff

---

## Files changed (estimated)

**External (Phase -1, separate repo):**
- `antfleet/aeon-bench` repo created public, with `BENCHMARK.md`, 30+ replay PR branches, 30+ open PRs

**New (Phase 1-4 on `spike/venice-consensus`):**
- `SPIKE.md` (repo root) — committed Phase 0, **amendment commit pending Step 2.0**
- `src/providers/venice.ts`
- `src/providers/venice.test.ts`
- `src/providers/__fixtures__/venice-review-with-findings.json`
- `src/providers/__fixtures__/venice-review-malformed.json`
- `src/providers/__fixtures__/venice-review-fenced.json`
- `scripts/build-aeon-bench.sh` (Phase -1 idempotent replay automation)
- `scripts/spike-per-pr.ts` (Phase 2 per-PR Venice-only harness, ~120-150 lines)
- `scripts/parse-baseline-comment.ts` (Phase 2 baseline-markdown parser, ~30 lines + tests)
- `scripts/analyze-venice-spike.ts` (Phase 3 metrics)
- `SPIKE_RESULTS.md`
- `BLOG_DRAFT_open_agent_stack.md`
- `.spike/venice-2026-05/pr-shortlist.json` (Phase -1 pre-registration anchor)
- `.spike/venice-2026-05/baseline-aeon-bench.json` (Phase -1 production-app baseline; refreshed pre-Phase-2)
- `.spike/venice-2026-05/aeon-bench/**/*.json` (Phase 2 per-PR-per-Venice-model raw)
- `.spike/venice-2026-05/marginal-contribution-shortlist.md` (Phase 3 manual-rating queue)

**Modified:**
- `src/provider.ts` — Step 2.0 amendment: rename `venice-llama-70b` → `venice-kimi-k2` (slug `kimi-k2-6`), rename `venice-deepseek-r1` → `venice-deepseek-v4` (slug unchanged)
- `src/spike/cost.ts` — drop `venice-llama-70b`, add `venice-kimi-k2`, rename `venice-deepseek-r1` → `venice-deepseek-v4`
- `.env.example` (2 new env vars; already done in Phase 1)
- `package.json` (add `spike-per-pr` script)

**Untouched (per brief):**
- `src/providers/anthropic.ts`
- `src/providers/openai.ts`
- `src/providers/stacked.ts` (R1 explains why)

---

## Handoff message template

```
Branch: spike/venice-consensus (local only, not pushed)
SPIKE.md commit (pre-registration SHA): <SHA>
Total estimated spend: $<TOTAL>
Verdict: <GOOD | MIXED | BAD>
Writeup: BLOG_DRAFT_open_agent_stack.md (do not publish)

Summary: <one paragraph: which Venice model (if any) produced
signal, the frontier_recall and marginal_contribution numbers
that drove the verdict, and the headline finding for the blog>.
```

---

## Open decisions for the user

These design calls were made unilaterally to keep the plan executable; flag any to revise before approval:

1. **Provider naming.** Three separately-named provider instances (`venice-qwen-coder`, `venice-deepseek-r1`, `venice-llama-70b`) rather than one `venice` with env-selected model. Matches brief's `--providers` syntax; lets `stacked.ts` report them distinctly in the agreement output.
2. **Mirroring openrouter.ts vs openai.ts.** Plan mirrors openrouter (json_object + fence-stripping). The brief is silent on the JSON-mode choice; this is the only choice that's likely to actually work against open models on Venice.
3. **Corpus adaptation in R2.** Treating each antseed sub-app as a separate corpus + 5× dogfood runs to reach the 30-invocation denominator, *instead of* asking the user to assemble a 30-PR fixture. If the user wants strict per-PR data, this is a 1–2 day prep blocker and the spike pauses.
4. **Cost estimates in `cost.ts`.** Brief says don't modify `anthropic.ts`/`openai.ts`; `cost.ts` is not mentioned, and adding Venice entries is necessary for `cost_per_agreed_finding`. Treated as in-scope.
5. **JSON output via `--json-out` flag** rather than always-on. Less disruptive to existing spike invocations and to baseline tests.

---

## Execution path (post-approval)

Phase ordering is strict: **Phase -1 → 0 → 1 → 2 → 3 → 4**. Phase -1 must produce the `pr-shortlist.json` SHA that Phase 0's `SPIKE.md` references — pre-registration depends on it.

- **Phase -1** (sequential): `/ralph` — bench-repo creation, replay automation, waiting on GitHub App baseline reviews. Wall-clock dominated by waiting for `antfleet[bot]` (~2 min per PR × 30 = ~1 hour, parallelizable if the app handles concurrent PRs).
- **Phase 0** (sequential): direct execution, one commit.
- **Phase 1** (parallelizable): `/team` — venice.ts + tests + fixtures + env are three independent file groups.
- **Phase 2** (sequential): Step 2.0 provider/cost amendments + SPIKE.md amendment commit → Step 2.1 smoke-test new models → Step 2.2 build harness → Step 2.3 harness smoke → Step 2.4 full execution. Live spike wall-clock: 15 PRs × 3 Venice models × ~30-60s/call ≈ 15-30 minutes. Run in background; cost-cap aborts safely.
- **Phase 3** (sequential): analysis script + manual rating pass on the marginal shortlist (~30 min human review of ~20 candidates).
- **Phase 4** (sequential): writeup draft. Must disclose: (a) actual corpus = 15 PRs not 30 due to baseline stall, (b) model trio refined pre-execution to qwen-coder + kimi-k2 + deepseek-v4 (SPIKE.md amendment commit cited).

Total estimated wall-clock: ~30 min Phase 2 + ~1-2 hours Phase 3-4 active work. Estimated Phase 2 spend: **~$5-10** against the $200 cap (45 Venice calls only; no frontier re-runs).
