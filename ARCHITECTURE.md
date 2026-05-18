# Architecture

AntFleet is a fork of [clawpatch](https://github.com/openclaw/clawpatch) (MIT). The inherited engine maps a repository into semantic feature slices, reviews each slice against a strict finding schema, and (in clawpatch) lands fixes through a patch loop. AntFleet keeps all of that and adds two things on top: a **stacked provider** that runs N independent models and emits only the findings they agree on, and a **GitHub App surface** (`apps/web/`) that turns those agreed findings into SHA-pinned receipts on real pull requests.

This document maps the inherited surface, then describes what AntFleet adds in two halves: the CLI engine in `src/` (provider stacking, agreement, dogfood) and the GitHub App surface in `apps/web/` (webhook, sweeper, onboarder, public receipt pages). The "Week 1 lock" sections are preserved where they explain the _why_ of a current design choice.

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
- `fix` produces a fix plan for one finding. Plan-only — no file mutation; applying patches is a separate concern.
- `revalidate` re-checks a finding against the current repo state (typically after a fix).

A factory `providerByName(name)` returns the implementation. Five are registered: `mock`, `mock-fail`, `anthropic`, `openai`, and `stacked`. Two more (`openrouter`, `codex`) ship as source in the tree but are not registered — see _Provider roster_ below for why. Output is constrained by JSON schemas (`reviewJsonSchema`, `fixPlanJsonSchema`, `revalidateJsonSchema`) defined in this file and parsed by the Zod schemas in `src/types.ts`.

**This is the seam we stack on.** A stacked provider is also a `Provider` — it just fans out and merges.

### Finding schema — `src/types.ts`

Findings, features, runs, patch attempts, and configs are all Zod schemas. The shapes that travel between providers and the rest of the engine:

- **`ReviewOutput`** — `{ findings: Finding[], inspected: { files, symbols, notes } }`. A finding has `title`, `category`, `severity`, `confidence`, `evidence[]`, `reasoning`, `reproduction`, `recommendation`, `whyTestsDoNotAlreadyCoverThis`, `suggestedRegressionTest`, `minimumFixScope`.
- **`Finding.evidence`** — `{ path, startLine, endLine, symbol, quote }`. The file:line range is the strongest signal we have for cross-provider agreement.
- **`Finding.category`** — `"bug" | "security" | "performance" | "concurrency" | "api-contract" | "data-loss" | "test-gap" | "docs-gap" | "build-release" | "maintainability"`.
- **`Finding.severity`** — `"critical" | "high" | "medium" | "low"`. The four-bucket scale is what the agreement primitive compares against.
- **`Finding.confidence`** — `"high" | "medium" | "low"`. Same three-bucket scale.
- **`FixPlanOutput`** / **`RevalidateOutput`** — used by the patch loop and the re-check loop respectively. The stacked provider passes them through; cross-provider plan merging is intentionally out of scope.

Validation is strict (`additionalProperties: false`), so providers cannot smuggle untyped fields into the workflow. Every Finding has a signature derived from category + evidence path/line, which is how clawpatch deduplicates within a single provider run.

### Slicer — `src/mapper.ts` + `src/mappers/`

The slicer reads the repo and emits `FeatureRecord` rows for each semantic unit — a CLI command, an HTTP route, a service, a UI flow, a job, an agent tool, a library, a config, a release, a test suite, an infra block. Language-specific mappers (`node.ts`, `python.ts`, `go.ts`, `rust.ts`, `swift.ts`, `apple.ts`, `gradle.ts`, `next.ts`) each detect their ecosystem and emit features with `ownedFiles`, `contextFiles`, `entrypoints`, and `tests`.

Output is deterministic. Same input repo → same features → same feature IDs. The slicer is what makes a Fleet review reproducible and a Fleet finding pinnable to a feature. AntFleet does not touch the slicer.

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
- `fix --finding <id>` — produce a fix plan (plan-only; an applier is downstream)
- `revalidate --finding <id>` / `--all` — re-check open findings
- `doctor` — verify the active provider is reachable
- `clean-locks` — clear stale feature locks

The workflow uses pessimistic locking on features so parallel `review` jobs do not double-claim. State lives in `.fleet/runs/`, `.fleet/findings/`, `.fleet/patches/`, `.fleet/reports/`, `.fleet/locks/` (all gitignored). The CLI surface — command names, flags, stdout shape — is the public contract of `@antfleet/cli` on npm.

### State engine — `src/state.ts`, `src/fs.ts`, `src/id.ts`, `src/git.ts`

JSON-file-per-record state with atomic writes. Features, findings, patches, runs each get their own directory. Feature IDs are content-derived (kind + canonical source path + title hash) so they survive re-runs. Git wiring detects the repo, current branch, HEAD SHA, and dirty state — the substrate for the SHA-pinned receipts the GitHub App emits.

## What AntFleet adds to the CLI

### Stacked provider — `src/providers/stacked.ts`

A `Provider` that wraps N child providers and fans out every call. `review` / `fix` / `revalidate` run all children in parallel via `Promise.allSettled`; if any child throws, the call is logged and dropped (graceful degradation, the others still vote). The merged output passes through the agreement primitive.

```ts
stackedProvider({
  providers: [anthropicProvider, openaiProvider],
  agreement: "unanimous" | "majority" | "any",
});
```

Registered in `providerByName` as `stacked`. Selectable via `FLEET_PROVIDER=stacked`; child set comes from `FLEET_STACKED_PROVIDERS` (default `anthropic,openai`) and gate from `FLEET_STACKED_AGREEMENT` (default `unanimous`).

### Agreement primitive — `src/providers/agreement.ts`

Two pure functions plus a small type:

- `findingsAgree(a, b)` — two findings agree when they share a category, their evidence covers overlapping file:line ranges, and their severity is within one bucket.
- `mergeFindings(perProvider, mode)` — returns `{ agreed: Finding[], disagreements: Disagreement[] }`. `unanimous` requires all N providers to flag a finding; `majority` requires > N/2; `any` requires ≥ 1.
- `Disagreement` — `{ providers: string[], finding: Finding, reason: string }` carries the rejected finding plus who flagged it.

This is the wedge. A single provider produces signal mixed with noise; an agreement filter is what lets us claim that what survives is worth a human's attention. The dogfood spike in `examples/dogfood/` is the measurement of whether the filter actually works on a planted-bug corpus.

### Anthropic and OpenAI providers — `src/providers/anthropic.ts`, `src/providers/openai.ts`

Two `Provider` implementations using the official SDKs. Structured output constrained to the existing `reviewJsonSchema`. `fix` is plan-only; no file writes from the provider. Auth is `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from env; `check()` throws with clear remediation if missing. Each module re-exports its default model id (`ANTHROPIC_DEFAULT_MODEL`, `OPENAI_DEFAULT_MODEL`) as a named constant so downstream surfaces can pin against it without duplicating string literals.

### Dogfood corpus — `examples/dogfood/`

A small synthetic TypeScript repo with planted bugs of varying difficulty (null-deref, race, SQL injection, missing input validation, deceptive comment). `scripts/spike.ts` runs the stacked provider against it and writes a markdown report. The first run is committed as `examples/dogfood-results/spike-baseline.md` and answers one question: **does agreement separate signal from noise on a known corpus?** The verdict lives in `examples/dogfood-results/WEEK1-VERDICT.md` and locks the v1 stack composition (see _Provider roster_).

## GitHub App surface — `apps/web/`

A Next.js app deployed to Vercel. Hosts the GitHub App webhook handler, a daily cron sweeper, the Onboarder agent, and the public receipt pages.

### Webhook — `apps/web/app/api/github/webhook/route.ts`

GitHub installation, repository, pull-request, and issue-comment events terminate here. Signature verification uses HMAC-SHA256 + `crypto.timingSafeEqual` (`apps/web/lib/github-signature.ts`). On a relevant `pull_request` action the handler dispatches to the review pipeline via `after()`; on `issue_comment` it captures `partner_reply` signals for the Onboarder. Unknown signed events return 200 silently.

### Review pipeline — `apps/web/lib/review-pipeline.ts`

For each dispatched PR the pipeline imports the registered providers from `@antfleet/cli/providers/*`, runs them in parallel, gates the result through `mergeFindings`, and writes findings + a per-provider audit row to Neon Postgres via Drizzle ORM. The `degraded` flag fires when fewer than the required number of providers succeed; a 1-of-1 "unanimous" is not a consensus and findings are held at `[]` for honesty.

### Sweeper + receipts — `apps/web/lib/sweep.ts`, `apps/web/lib/sweeper.ts`, `apps/web/lib/reactions.ts`, `apps/web/lib/pr-comment.ts`

Closure detection: a finding's evidence path being touched between `review.commit_sha` and current default-branch HEAD is the cheap proxy for "the bug got addressed." The sweeper runs daily via `apps/web/app/api/cron/sweep/route.ts` (gated by `CRON_SECRET` with constant-time compare) and posts closure receipts back as PR comments. Reactions on PR comments are polled and recorded as maintainer signals.

### Onboarder — `apps/web/lib/onboarder.ts`

A per-install agent that emits three lifecycle events: a welcome PR comment on install, a summary PR comment after the first review, and a 7-day check-in. Self-gates on `ONBOARDER_ENABLED`; idempotency is enforced via the `onboarding_events` table. The daily cron tick fans out check-ins eligible for the day. Captures `partner_reply` signals back from the webhook.

### Public surface — `apps/web/app/*`

Receipt pages — `/receipts`, `/receipts/[id]`, `/receipts.rss` — render the SHA-pinned audit trail of every public review. `/activity` streams recent reviews and Onboarder events. `/changelog` reads the repo's `CHANGELOG.md` and renders it server-side. `/architecture` is the live derivative of this document. `/roadmap` surfaces in-flight goals and open decisions. `/policy` is the contact / privacy stub.

All UI lives in `apps/web/app/`; shared library code in `apps/web/lib/`; DB schema and queries in `apps/web/db/`; one-off operator scripts in `apps/web/scripts/` (notably `weekly-digest.ts` for Phase 2 metrics). DB migrations are append-only under `apps/web/db/migrations/`.

## What is intentionally untouched

- **The slicer.** `src/mapper.ts`, `src/mappers/*` are the inherited body of work — language-aware feature detection across nine ecosystems. AntFleet does not touch it.
- **The finding schema.** Stacking only works because every provider speaks the same shape. `src/types.ts` stays exactly as inherited.
- **The state engine.** `.fleet/` layout, feature locking, atomic writes, ID derivation. All inherited and stable.
- **Inherited test suite.** Every test that came with clawpatch must continue to pass on every commit.

## Provider roster

### v1 stack — what ships

**`anthropic` (claude-opus-4-7) + `openai` (gpt-5), unanimous mode.** This is the registered default in `providerByName` and the stack the apps/web review pipeline executes against. The `fleet init` config writes `provider: { name: "stacked" }` and `buildStackedFromEnv` resolves to `anthropic,openai` unless `FLEET_STACKED_PROVIDERS` overrides it.

The pitch is intentionally narrow: **two independent frontier models must agree**. Not "N providers from a marketplace" — two. Same generation, same approximate capability, different vendors. The agreement filter is meaningful only when the voters are peer-tier; that is the whole point of locking the stack at this composition.

### Why not three? Why not cheap-tier diversity?

See [`examples/dogfood-results/WEEK1-VERDICT.md`](./examples/dogfood-results/WEEK1-VERDICT.md). The Week 1 measurement was three providers (`anthropic` + `openai` + `openrouter/deepseek-chat`) in unanimous mode. Unanimous catches 16% of planted bugs because unanimous degrades to the weakest voter's recall, and a price-stratified third voter (DeepSeek-V3 at ~1/30 the cost) catches only the single most obvious bug in the corpus. The cheap voter becomes a veto.

The corrective is not "add more cheap voters" or "fall back to majority mode" — both move the goalpost. The corrective is "make the stack be the two who actually agree on most things." That is the v1 lock.

### Not registered: `openrouter`, `codex`

Both providers remain in the tree:

- `src/providers/openrouter.ts` — OpenAI-compatible client pointed at `https://openrouter.ai/api/v1`, default model `deepseek/deepseek-chat`, fallback to `qwen/qwen-2.5-coder-32b-instruct` on malformed JSON. Live-network tests sit behind `describe.skip()` (no API key in CI) so the implementation does not bit-rot.
- `codex` provider, inline in `src/provider.ts` — shells out to the `codex` CLI; operator-installed, operator-billed.

Neither is registered in `providerByName`, so neither is selectable via config or `FLEET_PROVIDER`. Re-enabling either is a single-line factory change once real-repo data shows a third voter would add value rather than veto it. They are reachable for prototyping via `deferredV2Providers()` in `src/provider.ts`.

### Future consideration (≥6 months)

**Marketplace-as-router** (different model per task type) vs **marketplace-as-voter** (current design where every voter sees every task). Both designs benefit from the agreement primitive; they differ on what "agreement" measures. Today's voter model measures "did multiple frontier models independently flag this?". A router model would measure "did the right model flag this?" — which is a fundamentally different claim that the SHA-pinned-receipt narrative has to evolve to support. Decision deferred until real-PR data accumulates.

## Product surface boundary

The `Provider` interface is provider-agnostic. Concrete provider routing — which models AntFleet calls under what conditions — lives below this interface and is an implementation concern, never product copy. The user, the CLI, and the README see model identifiers (`claude-opus-4-7`, `gpt-5`) and the agreement primitive. They do not see internal routing.

The wedge is two-model agreement with SHA-pinned receipts. The moat is the receipt.
