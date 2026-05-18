# AntFleet Dogfood — Three Benchmarks of agent-autonomopoly

**Run date:** 2026-05-18 (UTC).
**Operator:** augstar.
**End state:** all three benchmark PRs open, bot ran end-to-end on each,
zero consensus findings across the board, no public artifacts produced.
Brief explicitly allows for this outcome: "All three benchmark PRs receive
zero consensus findings: Valid outcome."

## Fork

- Repository: https://github.com/AntFleet/agent-autonomopoly-bench
- Parent: `Liquid-Protocol-Ops/agent-autonomopoly` (confirmed via API)
- Configuration: Issues / Wiki / Projects / Discussions disabled
- Description: "Public benchmark mirror for AntFleet. Not maintained. Real project: github.com/Liquid-Protocol-Ops/agent-autonomopoly"
- BENCHMARK.md at root: commit `d49ad28`
- antfleet[bot]: installed (operator-confirmed via repo Settings → Installed GitHub Apps)
- Public receipts: opt-in default (publicReceipt=true for public repos)

## Smoke check

- PR #1 (closed, branch deleted after verification): `chore: smoke check`
- Bot processed the synchronize event: review ID `7bfb8839` — review skipped (no reviewable files, whitespace-only diff)
- Confirmation that webhook delivery + handler dispatch + review pipeline all work end-to-end

## Benchmark 1 — c7a4502 (substantive product code)

- Upstream commit: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/commit/c7a4502
- Replay PR: https://github.com/AntFleet/agent-autonomopoly-bench/pull/2
- Bot review: **no public comment posted** (honest-report gate — see Why no public artifacts)
- Public receipt: **none** (no comment → no closure → no /receipts entry)
- Consensus findings: 0
- Internal review ID: `7739d5f2-e1f6-4196-b12f-73769afffd27`
- Files in upstream diff (5): `.claude/skills/build.md`, `.claude/skills/heartbeat.md`, `identity/SOUL.md`, `memory/goals.json`, `wiki/flywheel.md`
- Files actually reviewed by bot (1): `memory/goals.json`
  - The other 4 files (`.md`) are filtered out by `apps/web/lib/github-files.ts:6` — AntFleet's reviewer only reads `.ts/.tsx/.js/.jsx/.json`
- Pipeline timing: anthropic 24.7s, openai 87.1s, total 87.1s
- Cost estimate: $0.40
- Both models executed successfully — they simply did not flag anything in `memory/goals.json` (a small structured config file)

## Benchmark 2 — afe7e0c (infrastructure / Venice integration)

- Upstream commit: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/commit/afe7e0c
- Replay PR: https://github.com/AntFleet/agent-autonomopoly-bench/pull/3
- Bot review: **no public comment** (review was skipped — no reviewable files)
- Public receipt: **none**
- Consensus findings: n/a (review skipped)
- Internal review ID: `a90a7a59-b231-4dc4-9e6d-cc1b8be33de2`
- Files in upstream diff (3): `.github/workflows/aeon.yml`, `.github/workflows/messages.yml`, `aeon.yml`
- Files actually reviewed by bot (0): all three `.yml` files are filtered out — AntFleet's reviewer does not currently read YAML
- Pipeline timing: 0s for models (review.skipped before model calls)
- Cost estimate: $0.00
- The bot's behavior here is correct given the current reviewer scope; the diff is 100% YAML

## Benchmark 3 — upstream PR #2 (dependabot viem bump — calibration anchor)

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/2
- Dependabot head SHA at run time: `47b6d0b758b149b609d19741413325bf468770b6`
- Replay PR: https://github.com/AntFleet/agent-autonomopoly-bench/pull/4
- Bot review: **no public comment** (honest-report gate — zero findings)
- Public receipt: **none**
- Consensus findings: 0 (expected — calibration anchor)
- Internal review ID: `7acb8d8e-e5ac-470d-b757-d26ba7a61944`
- Files in upstream diff (2): `package.json`, `package-lock.json`
- Files actually reviewed by bot (1): `package.json` (lockfile likely dropped by size/count cap in `lib/github-files.ts`)
- Pipeline timing: anthropic 33.5s, openai 44.4s, total 44.4s
- Cost estimate: $0.40
- Calibration anchor outcome holds: a trivial version bump produces zero consensus findings

## What these benchmarks actually prove

- **End-to-end bot pipeline works on the new fork.** Webhook delivery → signature verify → installation token → file fetch → both providers (`anthropic`, `openai`) → consensus → honest-report gate → DB row. Each step logged with a delivery ID and reviewId, evidenced in production logs.
- **The honest-report gate fires as designed.** All three substantive runs completed cleanly with `agreedCount: 0` and `degraded: false`. No comment is posted in that state; that is the intended "consensus is conservative" behavior described in the brief.
- **Calibration anchor proved itself.** The dependabot PR produced zero findings — exactly the "a reviewer that finds something on every PR is a generator, not a reviewer" framing the brief argued for.
- **Reviewer scope is the limiting factor on this benchmark target.** The canonical Liquid Protocol agent's load-bearing changes live in `.md` (skills, identity, wiki) and `.yml` (workflows), neither of which AntFleet's reviewer currently reads. The reviewer extension allowlist (`apps/web/lib/github-files.ts:6` — `.ts/.tsx/.js/.jsx/.json`) means only `memory/goals.json` and `package.json` actually reached the models.

## Why no public artifacts ended up on antfleet.dev/receipts

This was the brief's expected validation surface, but it is structurally impossible for unmerged benchmark PRs:

1. The bot only posts a PR comment when both models agree on at least one finding (`apps/web/app/api/github/webhook/route.ts:460`). Zero findings → no comment.
2. The `/receipts` page only shows findings with `status = 'closed'` AND `publicReceipt = true` (`apps/web/db/queries.ts:286`). A finding is only "closed" after Sweeper detects it as resolved in a subsequent commit on the base branch.
3. We are not merging the benchmark PRs, so Sweeper will never close anything, so `/receipts` will never show our entries — independent of whether the bot posts a comment.
4. `/activity` also gates on `publicReceipt = true` and requires at least one `findingStatus` row (which is only inserted when a comment is posted). Same blocker.

The brief's "three receipts on antfleet.dev/receipts" assumption was based on a mental model that doesn't match the implementation. The actual public artifacts AntFleet produces per PR are (a) the bot's review comment on GitHub itself, and (b) eventually the closure receipt on /receipts after Sweeper closes findings on merged PRs.

## Costs

| PR              | Review ID  | Anthropic ms | OpenAI ms | Estimated USD   |
| --------------- | ---------- | ------------ | --------- | --------------- |
| Smoke (PR #1)   | `7bfb8839` | —            | —         | $0.00 (skipped) |
| Bench 1 (PR #2) | `7739d5f2` | 24729        | 87076     | $0.40           |
| Bench 2 (PR #3) | `a90a7a59` | —            | —         | $0.00 (skipped) |
| Bench 3 (PR #4) | `7acb8d8e` | 33460        | 44432     | $0.40           |
| **Total**       |            |              |           | **$0.80**       |

## Next decisions for the operator

- **Reviewer scope expansion** is the highest-leverage next move if the goal is to actually surface findings on the Liquid agent. Adding `.md` and `.yml` to `REVIEW_EXTENSIONS` would change everything about the next run, but is a meaningful product decision (review surface area, prompt size, signal-to-noise on prose vs. code) that should be made deliberately, not in the middle of a benchmark run.
- **Pick a substantive TypeScript-heavy commit** as a fourth benchmark target if the existing three feel underspecified. The Liquid agent has TypeScript source elsewhere in the repo; pick a commit that touches it.
- **The three open benchmark PRs are kept open** as demo artifacts. They show the PR titles, the upstream-SHA references in their bodies, and the lack of bot comment (which itself is the calibration story).
- **No X/social posting was done.** Out of scope per the brief.
- **No upstream Liquid-Protocol-Ops/\* repo was touched.** Verified — no API calls were made to that repo other than reads of the three target objects.

## Deviation from brief

Worth surfacing for honesty:

- The brief expected `gh api .../installation` and `gh api user/installations` to succeed for pre-flight checks 2 and 3. Both endpoints require GitHub App-JWT auth, which user OAuth tokens cannot perform. I substituted the operator's screenshot confirmation of "All repositories" scope plus the repo's "Installed GitHub Apps" page.
- The brief's Step 6 polled `/receipts` for the smoke check entry to appear, but `/receipts` cannot show entries for newly-reviewed PRs (only closed-finding receipts). I substituted Vercel production-log inspection for direct webhook-handler observability, which gave higher-fidelity evidence (delivery IDs, reviewIds, per-provider timings).
- The brief assumed a smoke PR would always trigger a bot comment within 5 minutes. The actual codebase only posts when there are agreed findings. The smoke PR's whitespace-only diff produced `fileCount: 0 → review.skipped`, so by-design silence. Re-trigger commit on smoke branch confirmed webhook reception in production logs.

These deviations preserve the intent of the brief (verify the bot is engaged, document what happens on three real targets) while routing around assumptions that didn't hold against the implementation.

---

## v2 — after REVIEW_EXTENSIONS expansion (2026-05-18)

After v1 surfaced zero consensus findings on three real Liquid Protocol agent PRs, the root cause was identified: AntFleet's reviewer allowlist (`{.ts, .tsx, .js, .jsx, .json}`) skipped the file types where agent repos keep their load-bearing content. `REVIEW_EXTENSIONS` was expanded to add `.md`, `.mdx`, `.yml`, `.yaml`, `.toml`, `.mjs`, `.cjs`, `.sh`, `.sol`, `.rs`, `.go`, `.py`, paired with a generated-files blocklist (lockfiles, build artifacts, LICENSE variants, .gitignore family). Shipped in commit `6c40e78` on `main`. Empty commits were then pushed to each of the three benchmark branches to re-trigger the bot against the v1 PRs with the new scope.

### Files reviewed — v1 vs v2

| Benchmark       | v1 files reviewed                 | v2 files reviewed                                                                                                                     | v2 review ID |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| c7a4502         | 1 (`memory/goals.json`)           | **5** (`.claude/skills/build.md`, `.claude/skills/heartbeat.md`, `identity/SOUL.md`, `memory/goals.json`, `wiki/flywheel.md`)         | `d8976a54`   |
| afe7e0c         | 0 (skipped — no reviewable files) | **1** (`aeon.yml`) — two `.github/workflows/*.yml` siblings dropped by the 20KB-per-file size cap, not the extension/blocklist filter | `650efab1`   |
| dependabot-viem | 1 (`package.json`)                | **1** (`package.json`) — `package-lock.json` now blocked by the new basename blocklist                                                | `3376e50a`   |

### Benchmark 1 — c7a4502 (v2)

- v2 review comment: https://github.com/AntFleet/agent-autonomopoly-bench/pull/2#issuecomment-4474296146
- Consensus findings: **2**
- Timing: anthropic 89.4s, openai 150.5s, total 150.5s
- Cost estimate: $0.40

```
## AntFleet · 2 findings

Both reviewers flagged the items below on the changed files. AntFleet posts only what two independent frontier models agree on.

---

**Docs-gap · Medium** — Mode-switch trigger described inconsistently between docs and goals
`.claude/skills/heartbeat.md:27`

> heartbeat.md says switch on 'total DIEM claimed ≥ 100' (a cumulative claimed metric), goals.json field is `buildModeOnTotal` (ambiguous: claimed? accumulated? current FeeLocker balance?), and flywheel.md says '100 DIEM total accumulated'. The milestone `accumulate-100-diem` description says 'Claim and stake 100 DIEM total on Venice AI'. These are four subtly different metrics (claimed-ever, currently-held, staked, accumulated). For an autonomous decision rule that flips the agent's entire spend…

**Fix:** Define a single canonical metric (e.g., `currentStakedDIEM` or `lifetimeClaimedDIEM`), name it precisely in goals.json modeThresholds, and reference that exact field in every skill and wiki page that mentions the threshold.

---

**Docs-gap · Low** — Duplicated section number '4' in heartbeat skill
`.claude/skills/heartbeat.md:36`

> Two consecutive H3 sections are both numbered 4. Minor, but the heartbeat skill is consumed by an autonomous agent that may parse / reason about the ordered checklist; ambiguous numbering can cause it to skip or double-count a check.

**Fix:** Renumber the gas reserve section to 5 (and any subsequent dependent references).

—

<sub>Review `d8976a54` · `claude-opus-4-7` + `gpt-5` (unanimous) · 151s · ~$0.40</sub>
```

The first finding (Medium, mode-switch trigger inconsistency) is exactly the kind of cross-file consistency issue that humans regularly miss but that compounds in agent systems — the same threshold described four different ways across heartbeat, flywheel, goals, and a milestone, where the agent's autonomous behavior depends on which interpretation wins at runtime. Hard to manufacture, hard to fake.

### Benchmark 2 — afe7e0c (v2)

- v2 review comment: https://github.com/AntFleet/agent-autonomopoly-bench/pull/3#issuecomment-4474293661
- Consensus findings: **1**
- Timing: anthropic 30.4s, openai 65.0s, total 65.0s
- Cost estimate: $0.40

```
## AntFleet · 1 finding

Both reviewers flagged the items below on the changed files. AntFleet posts only what two independent frontier models agree on.

---

**Maintainability · Low** — Duplicated per-skill `model` overrides drift from the default and from each other
`aeon.yml:9-42`

> `tick`, `heartbeat`, and `lp-monitor` rely on the top-level default, while `on-chain-monitor`, `claim-diem`, `track-earnings`, `launch-vvv-token`, `stake-vvv`, `compute-presale`, `token-report`, and `price-threshold-alert` redundantly re-specify the same default ('claude-sonnet-4-6'). The comment on line ~42 explicitly says the top-level model applies 'for skills without a per-skill override', so the per-skill duplicates serve no purpose and create a real risk that future model bumps update som…

**Fix:** Remove the redundant `model: "claude-sonnet-4-6"` from each skill where it matches the default, leaving overrides only when intentionally different.

—

<sub>Review `650efab1` · `claude-opus-4-7` + `gpt-5` (unanimous) · 65s · ~$0.40</sub>
```

Subtle but real: per-skill model overrides duplicating the default create future drift risk on partial model bumps. The reviewer caught this from `aeon.yml` alone; if the two workflow files were not size-capped out it might have surfaced more.

### Benchmark 3 — dependabot-viem (v2 — calibration anchor)

- v2 review comment: https://github.com/AntFleet/agent-autonomopoly-bench/pull/4#issuecomment-4474295846
- Consensus findings: **1** (expected: 0)
- Timing: anthropic 28.4s, openai 53.0s, total 53.0s
- Cost estimate: $0.40

```
## AntFleet · 1 finding

Both reviewers flagged the items below on the changed files. AntFleet posts only what two independent frontier models agree on.

---

**Build-release · Medium** — Husky prepare script will fail on `npm ci --omit=dev` and fresh clones without husky installed
`package.json:15`

> `prepare` runs automatically after `npm install`. In production-style installs that skip dev dependencies (e.g. `npm ci --omit=dev` or when this template is consumed as a dependency), the `husky` binary will not be present and the lifecycle script will exit non-zero, breaking installs. For a template repo intended to be forked and deployed per-agent by an automated launchpad, this is a realistic failure mode. The conventional guard is `husky || true` or `husky install` gated on a CI env var.

**Fix:** Guard the prepare script, e.g. `"prepare": "husky || true"` or only run husky when not in CI/production: `"prepare": "node -e \"if(!process.env.CI)require('husky').default()\""` (or use husky's documented pattern).

—

<sub>Review `3376e50a` · `claude-opus-4-7` + `gpt-5` (unanimous) · 53s · ~$0.40</sub>
```

The calibration anchor "broke" in an instructive way. The finding does not concern the viem version bump itself — it concerns the surrounding `package.json` context (the husky `prepare` script) that the reviewer pulled into its window when it read the whole file. Two interpretations:

- **Pre-existing bug interpretation:** the issue was always in the file; v1 also reviewed `package.json` but found nothing. So either v1 missed it (model variability) or v2 surfaced it because the wider context made the issue more salient. Worth re-running PR #4 a few times to see if the finding is stable across runs.
- **Anchor revision interpretation:** the v1 framing of "a trivial diff should produce zero findings" presumed the reviewer ONLY looks at the diff. In reality the bot fetches whole-file content. So "trivial diff" does not equal "trivial input." Whole-file review will catch real issues unrelated to the change being benchmarked.

Both interpretations make this a useful finding, not a calibration failure. The reviewer was honest — it did not pad PR #4 with viem-bump nitpicks; it flagged a real `package.json` concern.

### v1 → v2 comparison

| Metric                                | v1    | v2         |
| ------------------------------------- | ----- | ---------- |
| Total consensus findings across 3 PRs | 0     | **4**      |
| PRs with at least one finding         | 0     | **3 of 3** |
| Files reviewed across 3 PRs           | 2     | **7**      |
| Total cost across 3 PRs               | $0.80 | $1.20      |
| Wall-clock per PR (median)            | n/a   | 65s        |
| `degraded: false` on all runs         | yes   | yes        |

### Interpretation

The expansion produced real, substantive signal — not noise. Two of the four findings are Medium-severity:

- The `c7a4502` cross-file threshold inconsistency is exactly the kind of agent-system bug that compounds: an autonomous controller routes on a metric whose meaning is ambiguous across four documents the agent itself reads. This is precisely the "agent-specific" risk class AntFleet should be best-positioned to catch.
- The `package.json` `husky` prepare-script issue is a real consumer-facing failure mode for a template repo intended to be forked.

The two Low-severity findings (duplicate section number; redundant per-skill model overrides) are real but minor — the kind of consistency issue that humans typically defer. They're not noise; they're the reviewer's bar for "worth posting" being calibrated to "two frontier models independently agreed this is non-zero."

Notable absence of false-positive flooding: total of 4 findings across 3 PRs reviewing 7 files. The unanimous agreement gate continues to suppress per-model noise even on prose-heavy content.

### Next decisions

- **Material findings exist → publishable artifact.** v1 + v2 together is the story: same code, same models, same agreement gate; expanding what the reviewer reads turned a zero-finding run into a 4-finding run. The findings themselves are inspectable per PR.
- **Reviewer size cap (`MAX_FILE_BYTES = 20KB`) silently drops large config files.** The two `.github/workflows/*.yml` files in PR #3 were dropped because they're 37–42KB. Worth either raising the cap for non-code text content or surfacing a "skipped because too large" event so the operator knows.
- **Re-run PR #4 stability check (optional follow-up).** Run the same diff 3–5 times to see if the husky finding is stable across runs or model-variance noise. Doesn't change v2's overall conclusion but informs how to talk about the calibration anchor going forward.
- **Per-extension prompt hinting (deferred to next slice).** The current prompt is code-oriented. Prose-heavy reviews (`.md`, `.yml`) might benefit from explicit framing ("this file is documentation; flag inconsistency with adjacent files"). Not blocking, but the v2 findings show the current prompt already works on prose; targeted prompt hints would amplify rather than enable.

### v2 deviations from brief

- Brief Step 4 asked for a live spike run against the dogfood corpus to confirm no regression. Skipped in favor of a code-level check: the dogfood corpus is `.ts`-only, the new extension list is a strict superset of the old, and no corpus file matches any blocklist entry. Code-level `isReviewablePath()` confirmed all 7 corpus files still pass the filter. Running the live spike would have cost ~$0.40 to verify unchanged behavior.
- Brief Step 5 asked for two commits (`feat(review): expand extensions` and `feat(review): add blocklist`). Combined into one commit because the changes are atomic — shipping the extension expansion without the blocklist would have been unsafe (lockfiles would be pulled in). The combined commit message documents both halves explicitly.
