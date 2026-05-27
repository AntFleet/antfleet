# AntFleet Positioning Thesis

**Status**: Active thesis. Adopted 2026-05-24. Predecessor strategy (FLEET-on-Liquid-launchpad) explicitly retired.

**One-line**: AntFleet is independent infrastructure — code review that every agent on every launchpad needs.

---

## The thesis

The agent economy is shipping code faster than any single reviewer can audit it. AI-generated code, solo-dev sprints, autonomous commits — at the same time, the agents writing this code are tokenized, traded, and trusted with real capital. Quality signal is missing.

AntFleet provides that signal. Every pull request on an enrolled agent repo is reviewed by two independent frontier models — `claude-opus-4-7` and `gpt-5`. Findings are only surfaced when both models agree, severity-rated, model-attributed, time-stamped, and published as public receipts at antfleet.dev. Closure is verified on the next commit.

AntFleet is not an agent. It is not on any launchpad. It is the layer underneath — independent infrastructure that every agent on every launchpad can install with one click.

## Why this framing (and not the original)

The original launch plan positioned AntFleet as an agent itself — FLEET token launched on the Liquid Protocol launchpad, paired with DIEM, funded by accumulated protocol fees that flowed through StakesaleVault. That plan was retired on 2026-05-24 for three reasons:

1. **Mechanism doesn't fit.** StakesaleVault (Liquid's only shipped launch path) seeds the AMM pool with raised DIEM; it does not forward DIEM to the agent's treasury wallet. AntFleet would not auto-fund its own Venice inference even if FLEET launched there.
2. **Timing is indefinite.** The Liquid launchpad is built by `agent-autonomopoly`, which is itself blocked on reaching 100 DIEM cumulative claims. At the time of writing, that agent is at 12.75 DIEM and has been in a CI-degradation loop for ~5 days. The launchpad shipping is months away, not weeks.
3. **Positioning is upside-limited.** "Agent #N on launchpad X" caps AntFleet's market at the size of launchpad X. "Independent layer that every launchpad needs" makes AntFleet bigger than any one ecosystem.

The decision: decouple the goals. Token launch is a Q3+ decision. Venice/inference funding comes from operating revenue (paywall stack already shipped). Ecosystem attention comes from multi-ecosystem dogfood receipts, not from launchpad presence.

## What AntFleet IS

- **Two-model consensus PR review.** Both models must agree before a finding is published. Single-model false positives are filtered by construction.
- **Webhook-driven, install-and-forget.** GitHub App install is the entire onboarding. No config, no API keys, no manual triggers.
- **Public-by-default for public repos.** Mission 5 default. Opt-out via `/policy` page or email request.
- **Continuous, not point-in-time.** Runs on every PR. Closure is verified on the next commit. Receipts accumulate.
- **Ecosystem-agnostic.** Liquid agents, Virtuals agents, Daos.fun agents, plain GitHub agents — identical mechanism, identical surface.
- **Independent.** No launchpad funding, no shared governance, no token co-launches. Quality signal credibility depends on this.

## What AntFleet is NOT

- **Not an agent.** No charter, no autonomous mission, no self-directed objectives. It is a service.
- **Not a launchpad competitor.** We make launchpad agents better; we don't compete for the same listing slots.
- **Not an audit firm.** Audits are point-in-time, expensive, human. AntFleet is continuous, cheap, automated.
- **Not a chain or protocol.** No on-chain coordination, no governance token, no consensus mechanism beyond model agreement.
- **Not a single-model reviewer.** That's table stakes. The "two models must agree" gate is the entire product.

## Audiences (three distinct value props)

### Agent maintainers (install side)

- **Value**: catch real bugs before they ship; public receipts build holder trust; free baseline, paid for heavy use.
- **Touchpoint**: GitHub App install → antfleet.dev/agents/<owner>
- **Conversion path**: dogfood receipts (e.g., `antfleet/agent-autonomopoly-bench`) demonstrate value publicly → maintainer installs on their own repo.

### Launchpad operators (integration side)

- **Value**: quality differentiation on their agent-detail pages; embeddable receipts widget; positive-sum (we make their agents better, we don't compete with them).
- **Touchpoint**: public receipts API, SVG badges, embed widget (when shipped).
- **Conversion path**: BD outreach backed by multi-ecosystem dogfood traction → integration partnership.

### Token holders / buyers (consumption side)

- **Value**: independent quality signal to assess agent code quality before buying the token.
- **Touchpoint**: `antfleet.dev/agents/<owner>`, `/benchmarks`, `/receipts`.
- **Conversion path**: receipts visible on launchpad detail pages (via launchpad integration) → habituated to checking AntFleet score as part of buy decision.

## Why "every agent, every launchpad"

The line is load-bearing, not aspirational. The proof points:

- **Liquid Protocol agents**: `antfleet/agent-autonomopoly-bench` shipped. Two-model review surfaced 4 consensus findings on real upstream commits. Two upstream fix PRs merged (#3 docs, #4 husky); one still open (#5 FeeLocker selector).
- **Virtuals Protocol agents**: dogfood brief drafted at `docs/autopilot/virtuals-dogfood-brief.md`. Same fork-and-benchmark pattern. Ships next.
- **Plain GitHub agents** (no launchpad): same mechanism works. No special-casing required.
- **Future launchpads**: same mechanism works. The webhook → consensus → receipt pipeline is launchpad-independent by design.

The "every" claim is provable. We keep proving it — one ecosystem at a time, until it becomes self-evident.

## Messaging architecture

### Layer 1 — Tagline

> AntFleet — independent code review for every agent on every launchpad.

**Surfaces**: X bio, README header, badge alt-text, GitHub App tagline.

### Layer 2 — Three-line

> Two-model consensus PR review for tokenized agents.
> Two independent reviewers — Anthropic + OpenAI — must agree before a finding is published. Works on every agent repo, on every launchpad, on every chain.
> Free for public repos. github.com/antfleet

**Surfaces**: antfleet.dev above-fold, partnership decks, GitHub App description, BENCHMARK.md template intro.

### Layer 3 — Paragraph

> The agent economy is shipping code faster than any single reviewer can audit it. AI-generated code, solo-dev sprints, autonomous commits — at the same time, the agents writing this code are tokenized, traded, and trusted with real capital. Quality signal is missing.
>
> AntFleet provides that signal. Every pull request on an enrolled agent repo is reviewed by two independent models — `claude-opus-4-7` and `gpt-5`. Findings are only surfaced when both models agree, severity-rated, model-attributed, time-stamped, and published as public receipts at antfleet.dev. Closure is verified on the next commit.
>
> AntFleet is not an agent. It is not on any launchpad. It is the layer underneath — independent infrastructure that every agent on every launchpad can install with one click.

**Surfaces**: README intro, /about hero, longer-form pitch decks.

### Layer 4 — Long-form thesis

This document.

**Surfaces**: linked from /about, partnership conversations, internal alignment.

## Tone rules

- **Direct, technical, evidence-first.** "4 consensus findings on agent-autonomopoly" is the right shape, not "tons of valuable insight."
- **Specific over general.** Name the models, name the repos, name the SHAs. Concrete details create trust.
- **No emoji, no hype, no lowercase-aesthetic.** AntFleet is infrastructure, not a vibes account.
- **Receipts over claims.** When in doubt, link to the artifact. The receipts are the artifact (this is already in the README and is the line that should propagate everywhere).

## What this thesis explicitly forecloses

To make the positioning defensible, certain doors close:

- **No FLEET token launch on Liquid Protocol.** Retired due to mechanism mismatch (StakesaleVault DIEM-flow) and timing (launchpad not shipped).
- **No Liquid-launchpad-dependent roadmap items.** The Liquid relationship continues via PRs (cheap, valuable), but no roadmap milestone depends on Liquid's pace.
- **No FLEET-as-agent-token narrative.** When FLEET eventually launches (Q3+, venue TBD), it will be positioned as a platform token (discount path, holder benefits, revshare) — not as the funding mechanism for AntFleet's inference.
- **No sourcing facts from `autonomopoly.pro` or similar lookalike domains.** Only canonical GitHub orgs and operator-confirmed sources.

## What this thesis explicitly opens

- **Multi-ecosystem dogfood**: Virtuals (next), Daos.fun, plain GitHub agents, future launchpads.
- **Launchpad integrations**: BD outreach to Virtuals, Daos.fun teams for embedded receipts.
- **Public consumption surfaces**: receipts API, SVG badges, embed widget.
- **Paywall activation**: USDC payments for paid reviews, funding Venice/inference from revenue not from speculation.
- **FLEET token (Q3+)**: platform token with discount/holder/revshare mechanics, venue chosen from traction position.

## Roadmap implications

What changes immediately:

1. README, /about, X bio, GitHub App description aligned to Layer 1-3 copy.
2. BENCHMARK.md template (used in bench forks) updated to universal-layer framing, not Liquid-specific.
3. Multi-ecosystem dogfood (Virtuals brief already drafted) becomes top priority workstream.
4. Paywall env var (`ANTFLEET_DEPOSIT_ADDRESS`) shipped to prod — Venice/inference funded from revenue.
5. SVG badge endpoint + receipts API surfaced as distribution rails (next-quarter work).

What stays the same:

- Two-model consensus product (no changes to review pipeline)
- Public-by-default receipts (Mission 5 default holds)
- Existing receipts at `antfleet/agent-autonomopoly-bench` (continue to maintain)
- Liquid relationship via PRs (open new ones when we find real bugs, keep PR #5 visible)

## Predecessor docs (retired thinking)

The following plans/briefs predated this thesis and contain framing that no longer applies. They are kept for historical reference but should not be cited as current strategy:

- FLEET-on-Liquid-launchpad plan (was implicit in early conversation; never formalized as a doc)
- Any "AntFleet as agent on Autonomopoly launchpad" framing
- StakesaleVault-funds-Venice mechanism analysis (mechanism understood, no longer load-bearing)
