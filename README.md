# AntFleet

Two independent frontier models review every pull request. Only the
findings they both agree on get posted. Every closure is pinned to the
commit SHA that resolved it. The receipts are the artifact.

Public site: <https://www.antfleet.dev> · receipts:
<https://www.antfleet.dev/receipts> · architecture:
<https://www.antfleet.dev/architecture>

## Status

Shipping in production:

- GitHub App at `antfleet[bot]`. Webhook handles `pull_request`,
  `installation.created`, `installation_repositories.added`, and
  `issue_comment.created`.
- **Reviewer fleet** — Claude Opus 4.7 + GPT-5, both runs on every
  PR in parallel, agreement gate `unanimous` by default. Only the
  intersection gets posted.
- **Sweeper** — daily cron at 06:00 UTC. Reconciles open findings
  against `main` HEAD; when the evidence file changed, posts a
  closure receipt comment pinned to the commit SHA.
- **Onboarder** — third agent (model-authored). Posts a welcome
  issue on install, a one-time framing comment on the first PR per
  install, and a 7-day check-in. Gated by `ONBOARDER_ENABLED`.
- **CLI workflow** — `fleet init` / `map` / `review` / `report` for
  local single-repo runs. The CLI predates the GitHub App and is
  still maintained for repos that prefer scripted invocation.

In the queue:

- **Patch Agent** — proposes fixes and pins a closure SHA on apply.
  Phase 3+ work; design partners pull this first.
- **Email intake** for the public-receipts opt-in flow at
  `agent@antfleet.dev`.

Phase status, design-partner cohort plan, and the strategy
substrate live operator-side; the public artifact is everything
on antfleet.dev.

## Install (GitHub App)

```text
https://github.com/apps/antfleet/installations/new
```

Recommended scope on first install: "Only select repositories".
Reviewer runs on every PR opened or synchronized; a busy org with
"All repositories" produces volume you didn't ask for. You can
broaden later from the same screen.

App permissions:

- `pull_requests: read` — read diff and changed files
- `issues: write` — post review comments, closure receipts, and
  (when Onboarder is enabled) the welcome issue
- `contents: read` — fetch file content at the PR head SHA
- `metadata: read` — repo metadata for the Onboarder welcome

Partner onboarding doc: [`docs/ONBOARDING.md`](./docs/ONBOARDING.md).

## Install (CLI)

```bash
pnpm add -g @antfleet/cli
```

From source:

```bash
pnpm install
pnpm build
pnpm link --global
```

The CLI is `fleet`. Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`
must be exported. Defaults: `claude-opus-4-7` and `gpt-5`.

## CLI workflow

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...

cd path/to/your/repo
fleet init
fleet map
fleet review
fleet report
```

`fleet review` defaults to the stacked provider in unanimous mode.
Individual providers via `FLEET_PROVIDER=anthropic|openai`. Agreement
mode override via `FLEET_STACKED_AGREEMENT=unanimous|majority|any`.

Spike runner for baseline experiments:

```bash
pnpm spike --providers anthropic,openai --mode unanimous --runs 5
```

## Public surfaces

- `/receipts` — every closed finding, anonymized by repo hash,
  linking to the original PR comment on GitHub
- `/receipts.rss` — RSS 2.0 feed of the same
- `/changelog` — per-release notes (operator-facing)
- `/architecture` — agent diagram + pipeline flowcharts
- `/activity` — live feed of recent reviews, agreed findings,
  closure receipts, and Onboarder actions; polls every 60s
- `/roadmap` — in-flight goals and the open decisions behind them
- `/policy` — plain-English data policy, MIT-style; covers what's
  collected, where it goes, and the public/private boundary

All routes are static-rendered or server-component-driven. No
client-side analytics, no third-party fonts at runtime.

## The fleet

| Agent                      | Kind           | Cadence        | Source of truth                            |
| -------------------------- | -------------- | -------------- | ------------------------------------------ |
| Reviewer · Claude Opus 4.7 | language model | per PR         | `src/providers/anthropic.ts`               |
| Reviewer · GPT-5           | language model | per PR         | `src/providers/openai.ts`                  |
| Agreement Gate             | deterministic  | per review     | `src/providers/agreement.ts`               |
| Sweeper                    | deterministic  | daily cron     | `apps/web/lib/sweep.ts`                    |
| Reaction Poller            | deterministic  | with sweep     | `apps/web/lib/reactions.ts`                |
| Onboarder                  | language model | webhook + cron | `apps/web/lib/onboarder.ts`                |
| Webhook Receiver           | deterministic  | per event      | `apps/web/app/api/github/webhook/route.ts` |

The agreement gate is the trust primitive. A finding only crosses
into the PR comment if both reviewers flagged the same code with
overlapping evidence. Silence on a PR means "no unanimous finding,"
not "no findings at all" — per-provider outputs persist to
`reviews.provider_responses` for analysis but never post.

## Repository layout

```text
.
├── src/                    CLI + stacked provider (npm: @antfleet/cli)
│   ├── provider.ts         four-method provider interface
│   ├── types.ts            zod-validated finding schema
│   ├── providers/          anthropic, openai, agreement, stacked
│   ├── mapper.ts           semantic feature slicer (clawpatch-derived)
│   ├── app.ts / cli.ts     workflow + commands
│   └── state.ts            .fleet/ state engine
│
├── apps/web/               Next.js App Router + Neon Postgres
│   ├── app/                routes (api + public surfaces)
│   ├── db/                 drizzle schema + queries + migrations
│   ├── lib/                review-pipeline, sweep, pr-comment,
│   │                       onboarder, github-app, github-files, …
│   └── scripts/            operator admin scripts (dotenv-loaded),
│                           e.g. weekly-digest.ts for Phase 2 metrics
│
├── docs/                   ONBOARDING.md, venice-integration.md
├── examples/               dogfood spike corpus + baseline reports
└── CHANGELOG.md            per-release ship log
```

## State and persistence

CLI state is project-local in `.fleet/`. The GitHub App writes to
Postgres (Neon, EU region). Tables:

- `reviews` — one row per webhook delivery, with per-provider
  responses, agreement decision, timing, and cost estimate
- `finding_status` — one row per agreed finding; status is
  `open | closed | superseded`
- `maintainer_reactions` — reaction polling output at 24h/7d/30d
- `onboarding_events` — Onboarder audit trail (welcome, summary,
  check-in, partner_reply)

Migration schema head: `0017_agent_findings_bench_repo`. Schema definitions
in `apps/web/db/schema.ts`; query layer in `apps/web/db/queries.ts`.

## Safety

- Reviewers never edit files. Agreement is the gate; silence is the
  correct output when there is no overlap.
- Sweeper only writes the closure receipt comment; it never edits
  source.
- Onboarder is gated by `ONBOARDER_ENABLED`. Default off. Idempotent
  per `(installation_id, owner, repo, event_type)` so a re-fired
  webhook can't produce duplicate issues or comments.
- Public receipts are opt-in per repo. Default off; flag flip via
  request to `agent@antfleet.dev`.
- Anonymization at write time — the public `/receipts` page renders
  `repo <8-char-prefix>`, not the raw owner/repo string.
- Provider outputs are parsed through strict Zod schemas; degraded
  reviews (any provider fails) are recorded but not posted.

See [`apps/web/app/policy/page.tsx`](./apps/web/app/policy/page.tsx)
for the customer-facing policy.

## Architecture

Full diagram and design notes in [`ARCHITECTURE.md`](./ARCHITECTURE.md).
Live pipeline flowcharts at
<https://www.antfleet.dev/architecture>.

Fork point in [`UPSTREAM.md`](./UPSTREAM.md).

## License

MIT — see [`LICENSE`](./LICENSE).

## Acknowledgements

AntFleet is built on top of
[openclaw/clawpatch](https://github.com/openclaw/clawpatch) (MIT).
Clawpatch contributed the slicer, finding schema, workflow, state
engine, CLI, and the entire single-provider review loop. AntFleet's
contribution is the stacked provider, the agreement primitive, the
multi-provider transports, the spike methodology, and everything
under `apps/web/` — the GitHub App, the Sweeper, the receipts
surface, and the Onboarder agent.
