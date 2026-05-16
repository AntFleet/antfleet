# Architecture

Antfeed Fleet is a fork of [clawpatch](https://github.com/openclaw/clawpatch) (MIT). The inherited engine maps a repository into semantic feature slices, reviews each slice against a strict finding schema, and (in clawpatch) lands fixes through a patch loop. Fleet keeps all of that and adds one thing on top: a **stacked provider** that runs N independent models and emits only the findings they agree on.

This document maps the inherited surface, then says what changes in week 1 and what does not.

## Inherited surface

### Provider seam — `src/provider.ts`

The provider is the only integration point models touch. Every provider implements four methods:

```ts
type Provider = {
  name: string;
  check(root: string): Promise<string>;
  review(root: string, prompt: string, model: string | null): Promise<ReviewOutput>;
  fix(root: string, prompt: string, model: string | null): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, model: string | null): Promise<RevalidateOutput>;
};
```

- `check` validates the provider is reachable (binary on PATH, API key in env, etc.).
- `review` produces a list of findings for one feature slice.
- `fix` produces a fix plan for one finding (clawpatch then applies it through its patch loop).
- `revalidate` re-checks a finding against the current repo state (typically after a fix).

A factory `providerByName(name)` returns the implementation. Today there are three: `codex` (real, shells out to Codex CLI), `mock`, and `mock-fail`. Output is constrained by JSON schemas (`reviewJsonSchema`, `fixPlanJsonSchema`, `revalidateJsonSchema`) defined in this file and parsed by the Zod schemas in `src/types.ts`.

**This is the seam we stack on.** A stacked provider is also a `Provider` — it just fans out and merges.

### Finding schema — `src/types.ts`

Findings, features, runs, patch attempts, and configs are all Zod schemas. The shapes that travel between providers and the rest of the engine:

- **`ReviewOutput`** — `{ findings: Finding[], inspected: { files, symbols, notes } }`. A finding has `title`, `category`, `severity`, `confidence`, `evidence[]`, `reasoning`, `reproduction`, `recommendation`, `whyTestsDoNotAlreadyCoverThis`, `suggestedRegressionTest`, `minimumFixScope`.
- **`Finding.evidence`** — `{ path, startLine, endLine, symbol, quote }`. The file:line range is the strongest signal we have for cross-provider agreement.
- **`Finding.category`** — `"bug" | "security" | "performance" | "concurrency" | "api-contract" | "data-loss" | "test-gap" | "docs-gap" | "build-release" | "maintainability"`.
- **`Finding.severity`** — `"critical" | "high" | "medium" | "low"`. The four-bucket scale is what the agreement primitive compares against.
- **`Finding.confidence`** — `"high" | "medium" | "low"`. Same three-bucket scale.
- **`FixPlanOutput`** / **`RevalidateOutput`** — used by the patch loop and the re-check loop respectively. The stacked provider passes them through but does not yet merge them in week 1 (no Patch Bot).

Validation is strict (`additionalProperties: false`), so providers cannot smuggle untyped fields into the workflow. Every Finding has a signature derived from category + evidence path/line, which is how clawpatch deduplicates within a single provider run.

### Slicer — `src/mapper.ts` + `src/mappers/`

The slicer reads the repo and emits `FeatureRecord` rows for each semantic unit — a CLI command, an HTTP route, a service, a UI flow, a job, an agent tool, a library, a config, a release, a test suite, an infra block. Language-specific mappers (`node.ts`, `python.ts`, `go.ts`, `rust.ts`, `swift.ts`, `apple.ts`, `gradle.ts`, `next.ts`) each detect their ecosystem and emit features with `ownedFiles`, `contextFiles`, `entrypoints`, and `tests`.

Output is deterministic. Same input repo → same features → same feature IDs. The slicer is what makes a Fleet review reproducible and a Fleet finding pinnable to a feature.

Fleet does not touch the slicer in week 1.

### Workflow — `src/app.ts`, `src/cli.ts`

`cli.ts` parses `fleet <command> [flags]` and dispatches to `app.ts`, which is the orchestration layer. The commands inherited from clawpatch:

- `init` — create `.fleet/`, detect project basics, write config
- `map` — run the slicer, write feature records
- `status` — show project state, dirty worktree, feature/finding counts
- `review` — run the configured provider against pending or selected features, jobs in parallel
- `report` — print or write a Markdown findings report
- `next` — pick the next actionable finding
- `show --finding <id>` — inspect one finding with evidence and validation hints
- `triage --finding <id> --status <status>` — mark a finding with history note
- `fix --finding <id>` — run the patch loop (provider produces plan, plan applies, validation runs)
- `revalidate --finding <id>` / `--all` — re-check open findings
- `doctor` — verify the active provider is reachable
- `clean-locks` — clear stale feature locks

The workflow uses pessimistic locking on features so parallel `review` jobs do not double-claim. State lives in `.fleet/runs/`, `.fleet/findings/`, `.fleet/patches/`, `.fleet/reports/`, `.fleet/locks/` (all gitignored).

Fleet lightly touches the CLI in later weeks (e.g., a `--stacked` flag for `review`). Week 1 leaves both files untouched.

### State engine — `src/state.ts`, `src/fs.ts`, `src/id.ts`, `src/git.ts`

JSON-file-per-record state with atomic writes. Features, findings, patches, runs each get their own directory. Feature IDs are content-derived (kind + canonical source path + title hash) so they survive re-runs. Git wiring detects the repo, current branch, HEAD SHA, and dirty state — the foundation for the SHA-pinned receipts that will come with the GitHub App.

Untouched in week 1.

## What we're building this week

### Stacked provider — `src/providers/stacked.ts`

A `Provider` that wraps N child providers and fans out every call. `review` / `fix` / `revalidate` run all children in parallel via `Promise.allSettled`; if any child throws, the call is logged and dropped (graceful degradation, the others still vote). The merged output passes through the agreement primitive.

```ts
stackedProvider({
  providers: [codexProvider, anthropicProvider, openaiProvider],
  agreement: "unanimous" | "majority" | "any",
})
```

### Agreement primitive — `src/providers/agreement.ts`

Two pure functions plus a small type:

- `findingsAgree(a, b)` — two findings agree when they share a category, their evidence covers overlapping file:line ranges, and their severity is within one bucket.
- `mergeFindings(perProvider, mode)` — returns `{ agreed: Finding[], disagreements: Disagreement[] }`. `unanimous` requires all N providers to flag a finding; `majority` requires > N/2; `any` requires ≥ 1.
- `Disagreement` — `{ providers: string[], finding: Finding, reason: string }` carries the rejected finding plus who flagged it.

This is the wedge. A single provider produces signal mixed with noise; an agreement filter is what lets us claim that what survives is worth a human's attention. The dogfood spike in `examples/dogfood/` is the first measurement of whether the filter actually works.

### Anthropic and OpenAI providers — `src/providers/anthropic.ts`, `src/providers/openai.ts`

Two more `Provider` implementations using the official SDKs. Structured output constrained to the existing `reviewJsonSchema`. Read-only `fix` in week 1 (no file writes — that's Patch Bot's job later). Auth is `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from env; `check()` throws with clear remediation if missing.

### Dogfood corpus — `examples/dogfood/`

A small synthetic TypeScript repo with planted bugs of varying difficulty (null-deref, race, SQL injection, missing input validation, deceptive comment). `scripts/spike.ts` runs the stacked provider against it and writes a markdown report. The first run is committed as `examples/dogfood-results/spike-baseline.md` and answers one question: **does agreement separate signal from noise on a known corpus?**

## What is intentionally untouched

- **The slicer.** `src/mapper.ts`, `src/mappers/*` are the inherited body of work — language-aware feature detection across nine ecosystems. We do not touch it.
- **The finding schema.** Stacking only works because every provider speaks the same shape. `src/types.ts` stays exactly as inherited.
- **The workflow and CLI.** `src/app.ts`, `src/cli.ts` orchestrate review, fix, revalidate, report. We do not add a `--stacked` flag this week; the spike script wires the stacked provider directly. CLI integration is a deliberate later step.
- **The state engine.** `.fleet/` layout, feature locking, atomic writes, ID derivation. All inherited.
- **Existing tests.** All 113 inherited tests pass after the rebrand and must continue to pass on every commit this week.

## AntSeed posture

Antfeed maintains a marketplace of model providers; one of those sources is AntSeed. **AntSeed never appears in the Fleet product surface.** No imports, no env vars, no flags, no copy. The `Provider` interface is provider-agnostic; the marketplace is an internal concern that lives behind the configuration layer. When marketplace routing ships, it will choose between concrete providers (`codex`, `anthropic`, `openai`, and whatever else qualifies) without exposing the routing source to the user, the CLI, or the README.

The wedge is multi-model verification with SHA-pinned receipts. The moat is the receipt. AntSeed-vs-X is a routing detail, not a product story.
