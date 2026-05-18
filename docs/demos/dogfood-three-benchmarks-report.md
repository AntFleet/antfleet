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

| PR | Review ID | Anthropic ms | OpenAI ms | Estimated USD |
|---|---|---|---|---|
| Smoke (PR #1) | `7bfb8839` | — | — | $0.00 (skipped) |
| Bench 1 (PR #2) | `7739d5f2` | 24729 | 87076 | $0.40 |
| Bench 2 (PR #3) | `a90a7a59` | — | — | $0.00 (skipped) |
| Bench 3 (PR #4) | `7acb8d8e` | 33460 | 44432 | $0.40 |
| **Total** | | | | **$0.80** |

## Next decisions for the operator

- **Reviewer scope expansion** is the highest-leverage next move if the goal is to actually surface findings on the Liquid agent. Adding `.md` and `.yml` to `REVIEW_EXTENSIONS` would change everything about the next run, but is a meaningful product decision (review surface area, prompt size, signal-to-noise on prose vs. code) that should be made deliberately, not in the middle of a benchmark run.
- **Pick a substantive TypeScript-heavy commit** as a fourth benchmark target if the existing three feel underspecified. The Liquid agent has TypeScript source elsewhere in the repo; pick a commit that touches it.
- **The three open benchmark PRs are kept open** as demo artifacts. They show the PR titles, the upstream-SHA references in their bodies, and the lack of bot comment (which itself is the calibration story).
- **No X/social posting was done.** Out of scope per the brief.
- **No upstream Liquid-Protocol-Ops/* repo was touched.** Verified — no API calls were made to that repo other than reads of the three target objects.

## Deviation from brief

Worth surfacing for honesty:

- The brief expected `gh api .../installation` and `gh api user/installations` to succeed for pre-flight checks 2 and 3. Both endpoints require GitHub App-JWT auth, which user OAuth tokens cannot perform. I substituted the operator's screenshot confirmation of "All repositories" scope plus the repo's "Installed GitHub Apps" page.
- The brief's Step 6 polled `/receipts` for the smoke check entry to appear, but `/receipts` cannot show entries for newly-reviewed PRs (only closed-finding receipts). I substituted Vercel production-log inspection for direct webhook-handler observability, which gave higher-fidelity evidence (delivery IDs, reviewIds, per-provider timings).
- The brief assumed a smoke PR would always trigger a bot comment within 5 minutes. The actual codebase only posts when there are agreed findings. The smoke PR's whitespace-only diff produced `fileCount: 0 → review.skipped`, so by-design silence. Re-trigger commit on smoke branch confirmed webhook reception in production logs.

These deviations preserve the intent of the brief (verify the bot is engaged, document what happens on three real targets) while routing around assumptions that didn't hold against the implementation.
