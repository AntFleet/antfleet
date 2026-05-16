# Antfeed Fleet

**Trust substrate for autonomous code. Two independent frontier models must agree. SHA-pinned receipts.**

Antfeed Fleet runs every pull request through two independent frontier models in parallel and posts only the findings they both agree on. Disagreements are surfaced; consensus is what reaches the human reviewer. Each closed finding is pinned to the commit SHA that resolved it — the receipt — so you can audit later whether the fix actually fixed it.

Fleet is the substrate underneath a family of automatons: Sweeper triages, Patch Bot lands small repairs with SHA pinning, Security and Perf specialists run on the same stacked plumbing. The wedge is two-model agreement. The moat is the receipt.

This repository is the **MVP scaffold**. The stacked provider is wired up end-to-end and tested. The dogfood corpus and Week 1 baseline are in `examples/dogfood/`; the real-repo Phase 0 baseline is in `examples/antseed-corpus/`. The GitHub App, Sweeper, and Patch Bot are next.

## Status

- Stacked provider with `unanimous` / `majority` / `any` agreement modes — **shipping**
- Two-provider default stack: Anthropic (`claude-opus-4-7`) + OpenAI (`gpt-5`) — **shipping**
- Synthetic dogfood corpus with planted bugs + spike runner + ground-truth report — **shipping**
- Real-repo Phase 0 corpus + 3-iteration baseline + GO/NO-GO verdict — **shipping**
- GitHub App + PR-comment posting — _Phase 1_
- SHA-pinned receipts for closed findings — _Phase 1_
- Patch Bot, Sweeper, and specialist providers — _later_

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the engine map and the provider-roster rationale.

## Quickstart

### Prerequisites

- Node.js 22+
- pnpm 11+
- Both of:
  - `ANTHROPIC_API_KEY` (defaults to model `claude-opus-4-7`)
  - `OPENAI_API_KEY` (defaults to model `gpt-5`)

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

FLEET_PROVIDER=stacked \
FLEET_STACKED_PROVIDERS=anthropic,openai \
FLEET_STACKED_AGREEMENT=unanimous \
fleet review
```

Stacked is the default: `fleet init` writes `provider: { name: "stacked" }` and the stacked builder defaults to `anthropic,openai` unanimous. Only findings where both providers agree on the file, line range, category, and (roughly) severity will land. Disagreements are recorded in `inspected.notes` so you can see what was filtered out and why.

### Dogfood baseline (synthetic)

To reproduce the Week 1 spike against the planted-bug corpus:

```bash
pnpm spike --providers anthropic,openai --mode unanimous --runs 5
```

The committed baseline lives at `examples/dogfood-results/spike-baseline.md` and the per-run reports at `examples/dogfood-results/run-{1..5}-*.md`. The Week 1 verdict is in [`examples/dogfood-results/WEEK1-VERDICT.md`](./examples/dogfood-results/WEEK1-VERDICT.md).

### Phase 0 baseline (real repo)

To reproduce the Phase 0 spike against the real-repo corpus:

```bash
pnpm spike --providers anthropic,openai --mode unanimous --runs 3 \
  --corpus examples/antseed-corpus
```

The Phase 0 verdict lives at [`examples/antseed-corpus-results/WEEK1-VERDICT-V2.md`](./examples/antseed-corpus-results/WEEK1-VERDICT-V2.md). It is the GO/NO-GO for Phase 1.

## Configuration

State lives in `.fleet/` (gitignored). Configuration via `fleet.config.json` at the repo root or `FLEET_*` environment variables. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the engine surfaces.

## Architecture

- **Provider seam** — `src/provider.ts`. Four-method interface (`check`, `review`, `fix`, `revalidate`) that every model speaks.
- **Stacked provider** — `src/providers/stacked.ts`. Wraps N children, fans out with `Promise.allSettled`, and merges through the agreement primitive.
- **Agreement** — `src/providers/agreement.ts`. Pure functions: `findingsAgree` (same category, overlapping evidence, severity within 1 bucket) and `mergeFindings` (union-find clustering, threshold by agreement mode).
- **Finding schema** — `src/types.ts`. Zod-validated, strict, the contract every provider speaks.
- **Slicer** — `src/mapper.ts` + `src/mappers/`. Inherited unchanged; maps the repo into semantic feature slices.
- **Workflow + state** — `src/app.ts`, `src/cli.ts`, `src/state.ts`. Inherited unchanged; orchestrates review, fix, revalidate, report, and pessimistic feature locking.

Full map and provider-roster rationale in [`ARCHITECTURE.md`](./ARCHITECTURE.md). The fork point is in [`UPSTREAM.md`](./UPSTREAM.md).

## License

MIT — see [LICENSE](./LICENSE). Attribution to the upstream project is preserved in both the license and the changelog.

## Acknowledgements

Antfeed Fleet is built on top of [openclaw/clawpatch](https://github.com/openclaw/clawpatch) (MIT). Clawpatch contributed the slicer, finding schema, workflow, state engine, CLI, and the entire single-provider review loop. Fleet's contribution is the stacking layer, the agreement primitive, the multi-provider transports, and the measured-against-ground-truth spike methodology that make two-model agreement a first-class operation.
