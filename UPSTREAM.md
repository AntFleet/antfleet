# Upstream

AntFleet is a fork of [openclaw/clawpatch](https://github.com/openclaw/clawpatch) (MIT).

## Fork point

- **Upstream repo:** https://github.com/openclaw/clawpatch
- **Upstream SHA:** `b03bf5200a7348165bca96dd1a89008ed718b25f`
- **Forked on:** 2026-05-16

## Posture

- `upstream` remote is read-only (push is disabled at the git level).
- We do not contribute changes back to clawpatch.
- We may pull selective bug fixes from upstream by cherry-pick; we do not rebase AntFleet onto upstream.
- If upstream ships a breaking change to the `Provider` interface mid-mission, we freeze on the original SHA above and migrate in a dedicated pass.

## What we kept untouched on the fork

- Slicer (`src/mapper.ts`, `src/mappers/`)
- Finding schema (`src/types.ts`)
- Workflow + CLI orchestration (`src/app.ts`, `src/cli.ts`)
- State engine (`src/state.ts`)

The rebrand was mechanical: identifiers, paths, environment variables. No behavior change in inherited code.
