# Open EVMBench learnings — what we applied, what we deferred

Date: 2026-06-18.
Origin: AntFleet's Phase 1 Detect reference submission to Open EVMBench
(`019ed936-364b`, 51/117 = 43.6%, claude-opus-4-7 + gpt-5 two-model
consensus). The Open EVMBench reference scaffold lives at
`~/open-evmbench/agents/antfleet_reference/consensus_agent.py`.

The Open EVMBench run produced a list of potential upgrades for AntFleet's
main review agents. This doc records which we ported and which we deferred,
so the next sprint can pick up the deferred items without re-doing the
analysis.

## What landed in this PR

### 1. Foundry broadcast filter

`apps/web/lib/github-files.ts` — `/broadcast/` added to
`REVIEW_BLOCKLIST_PATH_SUFFIXES`. `apps/web/lib/roast-runner.ts` —
`broadcast` added to `SKIP_DIRS`.

Reason: Foundry writes per-chain deployment receipts under `broadcast/`
(transaction hashes, gas reports, addresses). These are deployment
artifacts, not code under review — including them in the auditor prompt
trains the model on noise and risks treating address strings as evidence.

### 2. Roast-runner truncation marker

`apps/web/lib/roast-runner.ts` — file truncation at `MAX_BYTES_PER_FILE`
(50KB) now appends `[TRUNCATED: showing first N of M bytes]`. Was silent
before; matches the existing pattern in `src/prompt.ts:166` and
`apps/web/lib/github-files.ts:212`.

### 3. SOL-conditional smart-contract supplement

`src/spike/build-prompt.ts` — when any `.sol` file is in the bundle, the
prompt appends a soft supplement listing the smart-contract vulnerability
categories surfaced in the Open EVMBench reference `AUDITOR_PROMPT`:

- logic errors
- access control
- reentrancy
- oracle misuse
- accounting errors

Source: `~/open-evmbench/agents/antfleet_reference/consensus_agent.py`
AUDITOR_PROMPT, which lists these inline as "logic errors, access control,
reentrancy, oracle misuse, accounting errors, etc". Reproduced as a
SOL-conditional supplement so general-purpose review (TS/Go/Rust/Py) is
not biased toward smart-contract-shaped findings on non-EVM repos.

The supplement is advisory — the model still emits findings under the
existing `category` enum.

#### What we did NOT port (verification gap)

The upgrade prompt at
`~/open-evmbench/docs/internal/followups-2026-06-18/01-antfleet-main-repo-upgrade-prompt.md`
asserts scaffold v2 added an "explicit 7-category bug-class checklist"
and called for "verify against the Open EVMBench source — do not
paraphrase from memory". The actual `consensus_agent.py` source has
**five** categories embedded as a soft inline list, not seven, and not
as a numbered checklist. The two additional categories cited in the
followup doc — "token-handling edge cases (rebasing, fee-on-transfer,
ERC-777, missing approval)" and "replay / signature / EIP-712 issues" —
are not present in the actual reference scaffold. We ported what is
verified in source.

If the operator wants the additional two categories, that should be a
separate decision documented in the Open EVMBench scaffold first, then
ported here. Drift between AntFleet's main prompt and the scaffold that
produced the 43.6% result is the thing we are most exposed to: every
divergence makes "what scaffold made these findings" harder to answer.

## What we deferred — needs operator decision

### A. Reasoning-effort bump (`thinking` / `reasoning_effort`)

The upgrade prompt called for `--effort xhigh` on Claude and
`reasoning_effort: "high"` on Codex/GPT-5. AntFleet's main review path
uses the Anthropic SDK + OpenAI SDK directly (`src/providers/anthropic.ts`
and `src/providers/openai.ts`), not subscription CLIs, so the upgrade
shape is different:

- **Anthropic SDK** — would add `thinking: { type: "enabled",
  budget_tokens: <N> }` to `client.messages.create()`. Current
  `MAX_TOKENS=16384` is capped because 32768 trips the SDK's "use
  streaming for operations that may take longer than 10 minutes" guard
  (see comment at `src/providers/anthropic.ts:25-33`). Adding a thinking
  budget would push past that guard. Requires switching the provider to
  the streaming API (`client.messages.stream` + `finalMessage`) — a
  tracked follow-up, non-trivial.
- **OpenAI SDK** — would add `reasoning_effort: "high"` for gpt-5.
  Reasoning tokens compete with the output budget; at the current
  `max_tokens=16384`, `reasoning_effort: high` can starve the actual JSON
  response (the existing failure handler at
  `src/providers/openai.ts:152-170` already discriminates this case via
  `finish_reason=length` + `reasoning_tokens`).

Both changes have substantial cost and latency implications on the
production review path. Before flipping, we need:

1. A budget-tuning experiment on a known-good corpus (one reentrancy
   sample, one oracle sample, one >250KB Foundry repo) — measure
   detection delta and cost delta.
2. A decision on whether the bump goes behind an install-level env flag
   (`ANTFLEET_REASONING_EFFORT=high` per install) or globally.
3. A streaming-API migration for the Anthropic path if thinking-budget
   exceeds the SDK's 10-minute guard.

### B. Per-call timeout 3600s

The upgrade prompt called for "3600s minimum for Claude `--effort
xhigh`" on large repos. AntFleet's review pipeline runs under Vercel
function `maxDuration` (300s) — the 240s timeout in
`ANTHROPIC_CLIENT_OPTS` / `OPENAI_CLIENT_OPTS` exists to keep us under
that with headroom. The async-review path (`POST /review` returning
`202 + jobId`, see `apps/web/lib/review-job-worker.ts`) can in principle
run longer, but the worker is invoked from a cron handler that is itself
Vercel-bound.

Bumping per-call timeout to 3600s is blocked on either:
- moving the review worker to a non-Vercel runtime (e.g. a dedicated
  worker), or
- restructuring the async job to resume across function invocations.

This is a follow-up infrastructure decision, not an SDK config tweak.

### C. Source size cap (400KB total)

Open EVMBench scaffold caps total source bundle at 400KB
(`MAX_SOURCE_BYTES = 400_000` in `consensus_agent.py`) and truncates
mid-file silently. AntFleet's caps are stricter: 80KB per file with
diff-fallback above that (`MAX_FILE_BYTES`), 15 files max
(`MAX_FILES`), 150KB total prompt bytes (`MAX_TOTAL_PROMPT_BYTES`), all
in `apps/web/lib/github-files.ts:86-91`. The roast lane is wider: 50KB
per file, 20 files, 500KB total (`apps/web/lib/roast-runner.ts:27-29`).

We surface truncation explicitly in both lanes already (this PR adds
the missing roast surface). No bump is required from this learning;
the lesson is just "don't silently truncate".

## What doesn't apply

### D. Subprocess isolation discipline

The upgrade prompt enumerated flags for `claude --print` and
`codex exec` subprocess invocations:
`--setting-sources ""`, `--disable-slash-commands`,
`--strict-mcp-config`, `--allowed-tools ""`,
`--cd <isolated>`, `--skip-git-repo-check`, `--ignore-rules`,
`--ephemeral`, `--sandbox read-only`, redirected `CODEX_HOME`,
post-invoke isolation probe.

AntFleet does not invoke subscription CLI subprocesses in production
code. The codex provider at `src/provider.ts:118-139` is intentionally
deferred (v2-to-v1 fallback only). Verified via:

```
grep -rn "claude --print\|claude -p \|codex exec\|spawn.*claude\|spawn.*codex" \
  --include='*.ts' --include='*.js' --include='*.sh' .
```

No matches in production paths.

### E. Environment scrubbing (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`)

The upgrade calls for stripping these vars from the subprocess env to
prevent a stray `.env.local` from routing the `claude` CLI through the
Console API instead of the Max OAuth plan. Same reason as D: AntFleet
uses the Anthropic SDK directly with an `ANTHROPIC_API_KEY` from the
process env — there is no `claude --print` subprocess to scrub for.

## How to use this doc

When picking up a deferred item: open a PR scoped to one item, link
back to this doc, run the budget/cost experiment, and update this file
in the same PR with what changed.
