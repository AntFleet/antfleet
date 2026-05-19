# Standalone prompt — open responsible-disclosure PRs to aaronjmars/aeon

> **How to use this:** open a fresh Claude Code session in `/Users/augstar/projects/antfleet/` and paste the block below as your first message. The block is self-contained — the new session does not need to know anything about the prior Venice spike work.

> **Why a separate session:** the existing session is loaded with spike context. This task needs clean attention on delicate cross-repo PR work where each action affects an external maintainer.

---

````
/omc-plan

# Responsible-disclosure PRs for AntFleet-flagged findings in aaronjmars/aeon

## Background

AntFleet's production unanimous-agreement gate (Anthropic claude-opus-4-7 + OpenAI gpt-5)
reviewed 15 replay PRs of aaronjmars/aeon in the antfleet/aeon-bench mirror. It flagged
3 Critical security findings and 9 High-severity bugs/data-loss issues. 14 of those 15 PRs
are already MERGED into aaronjmars/aeon's main branch — the flagged code is live in
production. Public receipts exist on antfleet.dev/receipts and on the bench PR pages.

This task: open courteous, narrowly-scoped responsible-disclosure PRs to aaronjmars/aeon
proposing fixes for the highest-severity findings, with each PR linking back to the
public AntFleet receipt as evidence. Strategic goals: (a) be useful to the maintainer,
(b) demonstrate AntFleet's value in concrete patches, not just abstract reviews.

## Constraints (read carefully — many cross-cutting)

### Identity
- All GitHub writes must use the `antfleet-ops` account. Verify with
  `gh api user --jq .login` — must return `antfleet-ops`. If it returns
  anything else, run `gh auth switch --user antfleet-ops` and re-verify.
- Local git identity for any working clone must be set to
  `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>` so commits
  link to the antfleet-ops GitHub user (the `ops@antfleet.dev` address used in
  some legacy commits does NOT link to a GitHub user — use the noreply).

### Repo strategy
- aaronjmars/aeon is NOT in the antfleet org. Use the existing fork at
  `antfleet/aeon-bench` (verify: `gh repo view antfleet/aeon-bench --json parent`
  should show parent = `aaronjmars/aeon`). Branches go on the fork; PRs target
  `aaronjmars/aeon:main`.
- IMPORTANT — `antfleet/aeon-bench` already contains 30 replay PRs for benchmark
  purposes. The disclosure PRs are a DIFFERENT use of the same fork. Use branch
  prefix `disclosure/` (e.g., `disclosure/auth-secrets-api`) to keep them clearly
  separated from `bench/pr-N` replay branches.
- These PRs go to aaronjmars/aeon, NOT antfleet/aeon-bench. The bench mirror is
  just where the branches live before opening cross-repo PRs.

### Volume + scope control
- Open AT MOST 3 PRs in the first batch. Maintainer is solo-author (aaronjmars
  authored 173 of 179 PRs in the repo). Flooding their inbox is hostile.
- Prioritize the 3 Critical security findings. High-severity bugs are a possible
  second batch only after the first batch lands or gets a reception signal.
- One finding per PR. Even if two findings are in the same file, give the
  maintainer atomic units they can accept, reject, or modify independently.
- Each PR must be a minimal, scoped fix — not a refactor, not a re-architecture,
  not "while we're here, also let's clean up X".

### Verification before each PR
- For each finding, BEFORE opening a PR: re-check the file in the current
  aaronjmars/aeon main branch. The issue may have already been fixed in a
  subsequent commit since the original AntFleet review. If the issue is
  already addressed, SKIP that PR and note the skip in the handoff. Do not
  open a PR for a non-existent issue.
- For each proposed fix: ensure it compiles / passes existing tests in a local
  clone before pushing. The repo uses Next.js + TypeScript; check
  `package.json` for the test/lint/typecheck commands.

### PR body template (must include all of these)
```markdown
## Summary

<one-paragraph description of the issue and the fix>

## Evidence

This issue was flagged by AntFleet's two-model unanimous review gate on a
benchmark replay of #<UPSTREAM_PR_NUMBER>:

- AntFleet receipt: <PUBLIC_URL_OF_BENCH_PR_COMMENT>
- Original PR (merged <DATE>): https://github.com/aaronjmars/aeon/pull/<UPSTREAM_PR_NUMBER>
- Specific finding: **<SEVERITY> · <CATEGORY>** — <FINDING_TITLE>
- Location: `<file>:<line_range>`

The finding was an agreement between two independent frontier reviewers
(Claude Opus 4.7 + GPT-5). See https://antfleet.dev for context on the
review methodology.

## Proposed fix

<2-4 sentences describing what this PR changes and why it's the minimal
scoped fix. Acknowledge alternative approaches and explain the choice.>

## Notes for the maintainer

- This is a responsible-disclosure PR; you are under no obligation to merge.
- If you prefer a different approach (or have already addressed this in a
  separate WIP), feel free to close — the receipt stays on the bench PR
  regardless.
- Happy to revise the patch to match your project conventions if requested.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
````

### Tone

- Strictly courteous. Maintainer's project tagline is "no approval loops, no
  babysitting" — they may be philosophically resistant to gated review.
  Frame each PR as "FYI, the agreement gate flagged this; here's a patch in
  case it's useful" — never "your code is broken, here's how to fix it."
- No marketing in PR bodies beyond the single antfleet.dev link in Evidence.
- No claims about AntFleet capabilities beyond what's directly relevant.

### Safety

- Do NOT push to `aaronjmars/aeon` directly (you don't have rights anyway).
- Do NOT force-push, even on your own fork branches.
- Do NOT modify `antfleet/aeon-bench`'s main branch — branches only.
- Do NOT modify any existing `bench/pr-N` branches.
- Do NOT delete branches in `antfleet/aeon-bench`.
- Skip hooks: never use `--no-verify` on commits.
- If anything is ambiguous, STOP and ask the user before pushing.

## The findings to address

### Critical batch (first PRs — open these only)

#### Finding 1: Unauthenticated GitHub Actions trigger

- Upstream PR: aaronjmars/aeon#158 (merged 2026-05-06)
- File: `dashboard/app/api/skills/[name]/run/route.ts:11-18`
- Finding: "Unauthenticated endpoint can trigger GitHub Actions via gh CLI"
- AntFleet receipt: search for the antfleet[bot] comment on
  antfleet/aeon-bench#1 (use `gh api repos/antfleet/aeon-bench/issues/1/comments`)
- Proposed fix direction: add a minimal auth check using whatever auth pattern
  the rest of the dashboard uses. CHECK THE EXISTING DASHBOARD CODE FIRST for
  the convention — if there's no existing auth middleware, the fix scope grows
  significantly and may need to be raised as an issue first instead of a PR.

#### Finding 2: Missing auth on secrets API

- Upstream PR: aaronjmars/aeon#150 (merged 2026-05-03)
- File: `dashboard/app/api/secrets/route.ts:59-119`
- Finding: "Missing authentication/authorization on secrets API exposes credentials"
- AntFleet receipt: antfleet/aeon-bench#3
- Proposed fix direction: same as Finding 1, almost certainly. If both
  findings are in the same file and would be patched together, they MAY be
  one PR; but inspect first — they were two separate PRs originally
  (#150 and #169) so the maintainer's mental model may keep them separate.

#### Finding 3: Missing auth on secret-management endpoint

- Upstream PR: aaronjmars/aeon#169 (merged 2026-05-14)
- File: `dashboard/app/api/secrets/route.ts:95-145`
- Finding: "Missing authentication/authorization on secret-management endpoint"
- AntFleet receipt: antfleet/aeon-bench#25
- Likely overlap with Finding 2 — same file. Investigate whether ONE PR
  covers both, or whether they need separate scopes. The line ranges
  (59-119 vs 95-145) overlap, suggesting Finding 2's range may already
  include Finding 3's range, OR vice versa.

### Out of scope for this prompt

- The 9 High-severity bugs. Decide after Critical batch lands or gets feedback.
- The 13 Medium and 2 Low findings.
- Any PR to the VVVKernel Venice integration (aaronjmars/aeon#180 — closed
  upstream, not merged, so the finding doesn't apply to live code).

## Workflow

1. **Verify identity + setup** (gh auth, git config, working clone of
   antfleet/aeon-bench with upstream remote set to aaronjmars/aeon)
2. **For each Critical finding (1-3 above):**
   a. Read the file in CURRENT aaronjmars/aeon:main — is the issue still there?
   b. If skipped (already fixed), note and continue
   c. Inspect related dashboard files for the auth convention used elsewhere
   d. Design the minimal fix
   e. Present the fix plan + diff to the user; wait for explicit approval
   before pushing or opening the PR
   f. On approval: branch on antfleet/aeon-bench fork (`disclosure/<slug>`),
   commit, push, open PR to aaronjmars/aeon:main with the body template
   g. Record the PR URL
3. **At end:** report PRs opened, PRs skipped (with reason), any
   open question for the user.

## Acceptance criteria

- 0 or more PRs opened to aaronjmars/aeon (it's acceptable to open zero if
  all 3 issues turn out to be already-fixed)
- No PR was opened without explicit user approval at step 2e
- No branch was force-pushed
- antfleet-ops identity confirmed on every commit
- Every PR opened includes the AntFleet receipt link in its body
- Every PR opened is the minimal scoped fix (single file or tightly related
  files, no unrelated refactors)
- All PR bodies follow the template, including the "you are under no
  obligation to merge" line

## Handoff

When done, report:

- PRs opened: list of URLs
- PRs skipped: list with one-line reason each
- Any unresolved questions for the user
- Estimated time the maintainer needs to review (be honest — if you're
  proposing a 200-line auth scaffold, that's a multi-hour review for the
  maintainer; that's signal that the PR is too big and probably shouldn't
  have been opened)

```

---

## Notes for the operator (you)

- This prompt deliberately uses `/omc-plan`, not `/omc-ralph`. Cross-repo
  PRs to an external maintainer are exactly the case where you want the
  planning module to interview/plan first, get your approval on the PR
  STRATEGY, and only THEN execute one PR at a time.
- The "auth pattern in existing dashboard code" question is the critical
  unknown: if aeon's dashboard has no existing auth at all, then fixing
  these findings is a substantial design contribution, not a small patch.
  In that case the right move is to open one GitHub ISSUE explaining the
  finding set with links to the receipts — not multiple PRs imposing an
  auth design on aaronjmars's project.
- The session may decide all three findings are best raised as a single
  issue with three sub-headings, rather than three separate PRs. That's
  fine — the prompt's success criterion is "behave responsibly toward the
  maintainer," not "open three PRs."
- Worth running on a quieter day. If aaronjmars is mid-feature-sprint
  (visible from recent commit activity), wait a day or two.
- Do not run this in parallel with other AntFleet work that touches the
  bench repo — branch namespace is shared.
```
