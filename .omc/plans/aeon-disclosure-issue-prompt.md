# Standalone prompt — file ONE responsible-disclosure issue on aaronjmars/aeon

> **How to use this:** open a fresh Claude Code session in `/Users/augstar/projects/antfleet/` and paste the block below as your first message. The block is self-contained — the new session does not need to know anything about prior work.

> **Why a separate session:** filing an issue on an external maintainer's repo is a delicate, single-shot action. Clean attention matters.

> **When to prefer this over the PR-version prompt** (`aeon-disclosure-prs-prompt.md`): if there is no existing auth pattern in aeon's dashboard (i.e., these findings reveal a design-level gap, not a localized bug), filing PRs imposes a design choice on the maintainer. Filing a single issue with receipts respects their autonomy — they decide what to address and how.

---

```
/omc-plan

# Responsible-disclosure issue for AntFleet-flagged findings in aaronjmars/aeon

## Background

AntFleet's production unanimous-agreement gate (Anthropic claude-opus-4-7 + OpenAI gpt-5)
reviewed 15 replay PRs of aaronjmars/aeon in the antfleet/aeon-bench mirror on 2026-05-18.
It flagged 3 Critical security findings, 9 High-severity bugs/data-loss issues, plus 13
Medium and 2 Low. Of the 15 reviewed PRs, 14 are MERGED into aaronjmars/aeon's main — so
the flagged code is live. Public receipts exist on antfleet.dev/receipts and on the
bench PR pages.

This task: file ONE courteous responsible-disclosure issue on aaronjmars/aeon describing
the Critical + High findings, each linked to its public AntFleet receipt, leaving any
fix work entirely to the maintainer's discretion.

## Constraints (read carefully)

### Identity
- All GitHub writes must use the `antfleet-ops` account. Verify with
  `gh api user --jq .login` — must return `antfleet-ops`. If it returns
  anything else, run `gh auth switch --user antfleet-ops` and re-verify.
- No git commits are made by this task (issue-only). Identity matters only
  for the gh API call that files the issue.

### Volume
- **Exactly one issue.** Not multiple. Not a thread of issues by category.
- Issue includes ONLY Critical + High findings (12 total). Medium and Low
  are mentioned in aggregate ("plus 13 medium and 2 low findings; see full
  receipt list at antfleet.dev/benchmarks") so the maintainer can see them
  without an enumerated list cluttering the issue body.
- If the maintainer engages and asks for more detail later, that's their
  call — do not preemptively dump everything.

### Tone
- The maintainer's project tagline is *"no approval loops, no babysitting"*.
  Respect that — frame the issue as INFORMATION, not a request for action.
- Open with attribution + methodology in 2-3 sentences. Don't preach about
  agreement-gate philosophy.
- Each finding entry: minimum viable detail. Severity, category, one-line
  title, file:line, link to the public receipt. NOT a full repro guide.
  The receipt has the model's reasoning; the issue is an index, not a copy.
- Close with: "No obligation to act on any of these. Happy to send focused
  PRs on any subset if useful — just reply."

### Pre-flight verification
- For EACH Critical and High finding (12 total), BEFORE drafting the issue
  body: re-check the file in current aaronjmars/aeon main branch using
  `gh api repos/aaronjmars/aeon/contents/<path>?ref=main`. If the issue is
  already fixed in current main, OMIT it from the issue body (note in
  handoff that it was skipped because already fixed).
- The 12 findings span ~10 distinct files. Cache results locally to avoid
  duplicate gh API calls.

### Safety
- The issue is filed on aaronjmars/aeon. Verify the repo NAME before the
  `gh issue create` call — typos cost reputation.
- Show the user the EXACT issue body and title that will be filed, and get
  explicit approval, before invoking `gh issue create`. This is a one-shot
  external action.
- If user rejects the draft, revise and re-show. Do not file partial drafts.
- Do not file the issue with `--web` (opens browser, ambiguous about whether
  it actually filed). Use direct API.

## The findings to include

### Critical (3) — all in dashboard API surface

| # | Upstream PR | File | Finding |
|---|---|---|---|
| C1 | aaronjmars/aeon#158 (merged 2026-05-06) | `dashboard/app/api/skills/[name]/run/route.ts:11-18` | Unauthenticated endpoint can trigger GitHub Actions via gh CLI |
| C2 | aaronjmars/aeon#150 (merged 2026-05-03) | `dashboard/app/api/secrets/route.ts:59-119` | Missing auth/authz on secrets API exposes credentials |
| C3 | aaronjmars/aeon#169 (merged 2026-05-14) | `dashboard/app/api/secrets/route.ts:95-145` | Missing auth/authz on secret-management endpoint |

For each, the AntFleet receipt URL is the antfleet[bot] comment on the
corresponding bench PR. To get the URL for a given bench PR N:
```
gh api repos/antfleet/aeon-bench/issues/<N>/comments \
  --jq '.[] | select(.user.login=="antfleet[bot]") | .html_url' | head -1
```
The mapping: bench #1 = upstream #158 = C1; bench #3 = upstream #150 = C2;
bench #25 = upstream #169 = C3.

### High (9) — bugs and data-loss

Mapping bench-PR → upstream-PR (use this to fetch each receipt URL):
| Bench | Upstream | One-line title (verify against the receipt) |
|---|---|---|
| #12 | #160 (merged 2026-05-07) | v4-readiness manifest references files not included in the skill |
| #2 | #29 (merged 2026-04-13) | Slack bot-message filter is inverted: `BOT_ID = "null"` string |
| #21 | #163 (merged 2026-05-09) | Undefined `FORK_DEFAULT_BRANCH` used to fetch aeon.yml |
| #24 | #168 (merged 2026-05-14) | State file rollback uses non-existent `.bak`, can cause data loss |
| #25 | #169 (merged 2026-05-14) | Token reassembly from `claude setup-token` can splice in noise |
| #29 | #5 (merged 2026-03-30) | Security scanner uses PCRE tokens (`\s`, `\b`) with `grep -E` |
| #30 | #34 (merged 2026-04-14) | `branch` field in `skills.lock` ignored when fetching latest |
| #4 | #138 (merged 2026-04-21) | Daily spend circuit breaker compares strings as numbers via `awk` |
| #4 | #138 (merged 2026-04-21) | Ad set with only `campaignId` creates orphan record |

Note: bench PR #4 has two High findings — list both in the High section.
Note: bench PR #25 contributes one Critical AND one High (different lines in
the same file). List under their respective severity sections.

### Excluded
- bench PR #28 → upstream #180 (CLOSED unmerged — VVVKernel Venice integration).
  Finding does not apply to live code; skip.
- 13 Medium + 2 Low findings — summarize in the "Notes" section, do not
  enumerate.

## Issue body template

Use this structure exactly. Fill the placeholders with verified data.

```markdown
Hi @aaronjmars,

We benchmark agent-framework repos on [AntFleet](https://antfleet.dev) using a
two-model unanimous review gate (Claude Opus 4.7 + GPT-5). On 2026-05-18 we
ran the gate against 15 cherry-picked PRs from this repo via a public mirror
([antfleet/aeon-bench](https://github.com/antfleet/aeon-bench)). The gate
posted 27 findings as SHA-pinned receipts. 14 of the 15 reviewed PRs are now
merged into your main, so most of the flagged code is live.

This issue is informational — it is an index of the findings, each linked
to its public receipt. You are under no obligation to act on any of them.
Happy to send focused PRs on any subset if useful — just reply.

## Critical (3)

### C1 · Unauthenticated endpoint can trigger GitHub Actions via gh CLI
- **File**: `dashboard/app/api/skills/[name]/run/route.ts:11-18`
- **Source PR**: #158 (merged 2026-05-06)
- **Receipt**: <PASTE C1 RECEIPT URL>

### C2 · Missing authentication/authorization on secrets API
- **File**: `dashboard/app/api/secrets/route.ts:59-119`
- **Source PR**: #150 (merged 2026-05-03)
- **Receipt**: <PASTE C2 RECEIPT URL>

### C3 · Missing authentication/authorization on secret-management endpoint
- **File**: `dashboard/app/api/secrets/route.ts:95-145`
- **Source PR**: #169 (merged 2026-05-14)
- **Receipt**: <PASTE C3 RECEIPT URL>

## High (9)

[one block per High finding, same format as Critical]

## Notes

- Receipts are SHA-pinned to the commits as merged into your main. Subsequent
  commits may have addressed some of these — we verified each entry was still
  present in `main` as of <DATE>; entries since fixed are omitted.
- An additional 13 Medium and 2 Low findings exist in the receipt set; not
  enumerated here to keep this issue focused on the highest-impact items.
  Full receipts: https://antfleet.dev/receipts (filter by repo).
- Methodology and bench-mirror disclaimer: https://github.com/antfleet/aeon-bench/blob/main/BENCHMARK.md
- This issue was filed by [antfleet-ops](https://github.com/antfleet-ops); the
  reviews themselves are produced by independent frontier model API calls,
  not by AntFleet operators.

— AntFleet
```

## Workflow

1. Verify gh auth (`antfleet-ops` active)
2. For each of the 3 Critical + 9 High findings, fetch the receipt URL via
   `gh api repos/antfleet/aeon-bench/issues/<bench_N>/comments` — find the
   antfleet[bot] comment, take its `html_url`
3. For each finding, verify the file at `aaronjmars/aeon@main:<path>`
   still contains the issue (heuristic: file exists and contains the
   referenced symbol/pattern). If file deleted or symbol gone, mark as
   "likely fixed" and omit from the issue body.
4. Compose the full issue body using the template
5. Present the EXACT title + body to the user. Title: `"AntFleet two-model
   review surfaced 12 findings on recent merged PRs"`. Wait for explicit
   approval.
6. On approval: `gh issue create --repo aaronjmars/aeon --title "<TITLE>"
   --body-file <PATH_TO_TEMP_BODY_FILE>`. Use `--body-file`, not `--body`,
   to avoid shell-quote mangling.
7. Capture the returned issue URL; report in handoff.

## Acceptance criteria

- Exactly 0 or 1 issues filed on aaronjmars/aeon (0 acceptable if user
  rejects the draft or all findings turn out to be already fixed)
- The issue body includes only findings verified still present in current main
- No PRs were opened (this prompt is issue-only — defer PRs to the
  PR-version prompt at `aeon-disclosure-prs-prompt.md`)
- gh CLI commands all used antfleet-ops as the active account
- The "no obligation to act" line is present in the issue body
- No marketing language beyond the antfleet.dev / antfleet/aeon-bench
  links in the methodology lines

## Handoff

When done, report:
- Issue URL (or "user rejected the draft" / "all findings appeared already
  fixed in current main")
- Findings omitted (with one-line reason each)
- Active gh account at filing time (must be `antfleet-ops`)
- Any unresolved questions for the user
- Suggested follow-up: if the maintainer responds positively, the
  PR-version prompt (`aeon-disclosure-prs-prompt.md`) is the natural
  next step.
```

---

## Notes for the operator (you)

- This is the lighter-touch alternative to the PR-version prompt. Pick this
  if: you want to disclose without imposing a fix design; OR you've discovered
  aeon has no existing auth pattern at all (in which case PRs would force
  a design decision on the maintainer).
- Single issue is RECOVERABLE if the maintainer doesn't engage. Multiple PRs
  are louder and may sour the relationship if ignored.
- If the maintainer responds positively (comments on the issue, asks for
  patches), THEN run the PR-version prompt as a follow-up. The two prompts
  are designed as a sequence: issue first, PRs only if invited.
- aaronjmars is active daily — expect a response within 24-48 hours, or
  none ever. Don't escalate either way.
- Today's date (2026-05-19) is fresh — aaronjmars's last PR activity was
  2026-05-17. Probably a fine time to file. Avoid filing on weekends if
  you can — Tuesday/Wednesday GitHub mornings see best response rates.
