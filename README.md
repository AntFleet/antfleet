# Antfeed Fleet

**Trust substrate for autonomous code. Multi-model verification. SHA-pinned receipts.**

Antfeed Fleet runs every pull request through several independent models in parallel and posts only the findings they agree on. Disagreements are surfaced; consensus is what reaches the human reviewer. Each closed finding is pinned to the commit SHA that resolved it — the receipt — so you can audit later whether the fix actually fixed it.

Fleet is the substrate underneath a family of automatons: Sweeper triages, Patch Bot lands small repairs with SHA pinning, Security and Perf specialists run on the same stacked plumbing. The wedge is multi-model verification. The moat is the receipt.

This repository is the **week-1 spike**. The stacked provider is wired up end-to-end and tested. The dogfood corpus and baseline run are in `examples/dogfood/`. The GitHub App, Sweeper, and Patch Bot are next.

## Status

- Stacked provider with `unanimous` / `majority` / `any` agreement modes — **shipping**
- Anthropic, OpenAI, and Codex providers under one `Provider` interface — **shipping**
- Synthetic dogfood corpus with planted bugs + spike runner + ground-truth report — **shipping**
- GitHub App + PR-comment posting — _next_
- SHA-pinned receipts for closed findings — _next_
- Patch Bot, Sweeper, and specialist providers — _later_

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the inherited slicer, finding schema, workflow, and state engine fit together with the new stacked layer.

## Quickstart

### Prerequisites

- Node.js 22+
- pnpm 11+
- One or more of:
  - `ANTHROPIC_API_KEY` (defaults to `claude-opus-4-7`)
  - `OPENAI_API_KEY` (defaults to `gpt-5`)
  - `codex` CLI on `PATH` for the codex provider

### Install

```bash
pnpm install
pnpm test
```

### Single-provider review

```bash
export ANTHROPIC_API_KEY=...
cd path/to/your/repo
fleet init
fleet map
FLEET_PROVIDER=anthropic fleet review
fleet report
```

### Stacked review (the wedge)

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
# codex CLI auth managed separately

FLEET_PROVIDER=stacked \
FLEET_STACKED_PROVIDERS=codex,anthropic,openai \
FLEET_STACKED_AGREEMENT=unanimous \
fleet review
```

Only findings where all three providers agree on the file, line range, category, and (roughly) the severity will land. Disagreements are recorded in `inspected.notes` so you can see what was filtered out and why.

### Dogfood baseline

To reproduce the week-1 spike against the planted-bug corpus:

```bash
pnpm spike
```

The report lands in `examples/dogfood-results/<timestamp>.md`. The committed baseline at `examples/dogfood-results/spike-baseline.md` records the very first run; it is honest about what was and was not measured.

## Configuration

State lives in `.fleet/` (gitignored). Configuration via `fleet.config.json` at the repo root or `FLEET_*` environment variables. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the engine surfaces.

## Architecture

- **Provider seam** — `src/provider.ts`. Four-method interface (`check`, `review`, `fix`, `revalidate`) that every model speaks.
- **Stacked provider** — `src/providers/stacked.ts`. Wraps N children, fans out with `Promise.allSettled`, and merges through the agreement primitive.
- **Agreement** — `src/providers/agreement.ts`. Pure functions: `findingsAgree` (same category, overlapping evidence, severity within 1 bucket) and `mergeFindings` (union-find clustering, threshold by agreement mode).
- **Finding schema** — `src/types.ts`. Zod-validated, strict, the contract every provider speaks.
- **Slicer** — `src/mapper.ts` + `src/mappers/`. Inherited unchanged; maps the repo into semantic feature slices.
- **Workflow + state** — `src/app.ts`, `src/cli.ts`, `src/state.ts`. Inherited unchanged; orchestrates review, fix, revalidate, report, and pessimistic feature locking.

Full map is in [`ARCHITECTURE.md`](./ARCHITECTURE.md). The fork point is recorded in [`UPSTREAM.md`](./UPSTREAM.md).

## License

MIT — see [LICENSE](./LICENSE). Attribution to the upstream project is preserved in both the license and the changelog.

## Acknowledgements

Antfeed Fleet is built on top of [openclaw/clawpatch](https://github.com/openclaw/clawpatch) (MIT). Clawpatch contributed the slicer, finding schema, workflow, state engine, CLI, and the entire single-provider review loop. Fleet's contribution this week is the stacking layer, the agreement primitive, and the multi-provider transports that together make multi-model verification a first-class operation.
