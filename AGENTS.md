# AntFleet Agent Guide

This file is the canonical instruction surface for every coding agent in this
repository (Codex reads `AGENTS.md`; Claude Code loads it via the sibling
`CLAUDE.md` import). Keep it short, concrete, and current. Put long incident
writeups in `.omc/runbooks/` and link them from here — do not paste operator
runbooks into the tracked public tree.

## Public-repo note

This repository is **public**. The AntFleet strategy substrate is operator-internal
and lives outside this repo; public surfaces may cite section numbers (`§5`,
`§18.2`, …) that point at that private file. Never commit strategy material,
secrets, home-directory paths, tokens, or operator-only credentials here. New
repositories are still created private-by-default.

## Project Overview

AntFleet is an AI-driven security-review fleet: it audits smart-contract and
software targets, grounds findings, and turns verified results into public
receipts. The repo is a pnpm workspace — a root TypeScript package (the Solidity
finder sidecar + `antfleet-audit` CLI and shared libraries) plus `apps/web` (the
Next.js site, review pipeline, and Postgres/Drizzle data layer on Neon).

Read the nearest implementation files before editing. Behavior in the finder is
governed by the specs in `specs/` and the module docs in `src/sidecar-solidity/`.

## Project Structure

- `src/` — root package sources; `src/sidecar-solidity/` is the whole-contract
  Solidity finder (closure assembly, two-stage finder, refuter, sweep, CLI).
- `apps/web/` — Next.js app: public site, review/webhook pipeline, Drizzle schema
  and migrations, scripts.
- `specs/` — normative specs for the finder and pipeline.
- `scripts/`, `examples/`, `data/` — helper scripts, fixtures, seed data.
- `docs/`, `ARCHITECTURE.md`, `CHANGELOG.md`, `UPSTREAM.md` — documentation.
- `.omc/` — operator runbooks, decisions, specs-in-progress, and orchestration
  state. **Local-only, gitignored; never PR'd.**

## Setup And Build

Use the pinned package manager and lockfile; do not add dependencies without
explicit approval. Node `>=22`, pnpm.

```bash
pnpm install
pnpm build                 # root package: tsc -p tsconfig.build.json
pnpm --filter web build    # apps/web: next build
```

## Testing And Checks

Run the smallest relevant test while iterating, then the broader gate for the
surface you changed.

```bash
pnpm test                  # vitest run (whole workspace)
pnpm typecheck             # tsc --noEmit
pnpm lint                  # oxlint
pnpm format:check          # oxfmt --check   (run before every push)
```

Scope a single file or suite while iterating:

```bash
npx vitest run src/sidecar-solidity/            # one directory
npx vitest run src/sidecar-solidity/closure.test.ts
```

Never claim an interrupted, skipped, or timed-out run passed. Report the exact
command and result. `apps/web` live/smoke tests gated on external API keys
(e.g. `ZHIPU_API_KEY`) fail without the key — that is pre-existing, not your
regression; say so explicitly rather than silencing them.

## Code Style

- TypeScript: `oxlint` clean, `oxfmt` formatted. Run `pnpm format:check` (and
  `pnpm format` to fix) before pushing — a formatting-only CI failure is
  avoidable noise.
- Follow neighboring patterns; do not reformat unrelated files.
- Comments explain non-obvious constraints, not restate the code. Match the
  surrounding comment density and idiom.

## Git Workflow — worktrees and branches

**The shared primary checkout (`this repo root`) is not yours alone.** Multiple
agents and sessions operate in it concurrently; committing write-heavy work there
lets a concurrent session move `HEAD` under you, so your commits land on the
wrong branch. Do not do write-heavy work in the shared checkout unless the user
explicitly says to use it.

Start every task from a fresh, isolated worktree **under `/tmp/`** (never under
`~/projects/` — transient checkouts must not pollute the project tree):

```bash
git status -sb
git worktree list
git fetch origin
git worktree add /tmp/antfleet-<topic> -b <scope>/<topic> origin/main
cd /tmp/antfleet-<topic>
```

- **One branch per task.** Use a descriptive branch name (`scope/topic`), never a
  `claude/<codename>` placeholder. If a tool created a placeholder, rename it
  BEFORE the first push (renaming after a PR is open closes the PR).
- Before pushing or opening a PR, verify `git log origin/main..HEAD` contains
  only the current task.
- **Do not let local `main` outrun `origin/main`.** `git fetch` and branch off
  `origin/main`, not a stale local `main`.
- The working tree carries unrelated WIP and stashes. **Never blind
  `git stash pop`** — isolate with a worktree instead.

When the task's PR is merged, clean up so the next session starts sane:

```bash
git worktree remove /tmp/antfleet-<topic>       # from the primary checkout
git branch -d <scope>/<topic>                   # delete the merged local branch
git -C <primary checkout> checkout main
git -C <primary checkout> fetch origin && git -C <primary checkout> merge --ff-only origin/main
```

## Git Identity And Ship Flow

- **Writes to AntFleet use the `antfleet-ops` GitHub account.** Verify the active
  account before pushing (`gh auth status`) and switch with
  `gh auth switch --user antfleet-ops`. Do not embed tokens in remote URLs.
- **`main` is protected by a local pre-push hook** (GitHub-side branch protection
  is unavailable on this plan). Direct pushes to `main` are blocked. Ship via
  **branch → PR → green CI → merge**. The `ALLOW_MAIN_PUSH=1` override is for
  genuine emergencies only, with explicit user approval in the current turn.
- **Org auto-merge is disabled** — merge the PR manually once CI is green and
  review is accepted. Green CI + accepted review → merge without re-asking; do
  not make the user press the button. Merge on red only as an explicitly
  authorized, documented exception.
- After any change touching `apps/web`, **verify the Vercel deploy** rather than
  assuming green.

## Audit Gate

An implementation slice is not done until the **full fix diff** is audited — every
commit of the fix combined, scoped to the fix's files, not an incremental
follow-up slice layered on an already-merged part. Reconstruct it from the base
commit before the fix's first commit: `git diff <base> -- <fix files>` up to the
working tree; never diff against `origin/main` when `main` already contains an
earlier part of the same fix.

Run a 3-lane audit over that combined diff before merging any significant impl —
code review, security review, architecture review. Use native Codex
subagents/auditor lanes in Codex sessions; `omc ask codex` is the fallback
elsewhere. Gate: 0 CRITICAL, 0 HIGH, 0 MEDIUM across all lanes; LOW/INFO may be
carried explicitly.

## Boundaries

- Never commit secrets, API keys, `.env` files, private keys, or operator-only
  credentials. Keep scratch files, editor state, and orchestration logs out of
  the tracked tree — use `.omc/`, `.claude/`, or `scratchpad/`.
- **Never create Neon database branches** — each one holds a minimum compute unit
  and blows the budget. Use the exported dev/prod connection URLs instead.
- Worktrees live under `/tmp/`, never `~/projects/`. If you find one under the
  project tree, `git worktree move` it to `/tmp/` or remove it.
- Operator runbooks and decisions stay in `.omc/`, not repo PRs.
