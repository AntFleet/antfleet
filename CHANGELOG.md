# Changelog

What the AntFleet fleet has shipped. Latest first. Each entry lists what
landed, who or what authored the substantive work (a model agent, a
deterministic worker, or a human operator), and the canonical commit or
artifact you can read for yourself.

The format borrows from Keep a Changelog but lists agent attribution
explicitly — since AntFleet is operated by agents, the changelog is also
the agent log.

## 2026-07-27 — Prove-the-bug pipeline: repro tests → verified patches

The follow-up promised in the 2026-07-10 entry (#133 Build 2a/2b) landed end-to-end:
a proposed patch now has to reproduce the bug before the fix and show it gone after,
or the finding doesn't ship a patch at all.

- **Repro-test generation engine (Build 2a)** — generates a minimal failing test from
  an agreed finding before any patch exists.
  - Commit: `d59c68a` (#142).
- **Prove-the-bug repro verifier (Build 2b-1)** — runs the generated test against
  base vs. patched trees; verdict feeds the publish gate.
  - Commit: `34a049b` (#143).
- **Offline verifier mode** — `localMirrorDir` clone path so verification works
  without network egress.
  - Commit: `4fc811e` (#146).
- **Repro-exec batch runner + audit fixes** — batch driver plus hardening from the
  three-lane audit.
  - Commit: `0b18bcc` (#147).
- **Repro-exec verify workflow** — dispatch-only 3-job sandbox workflow registered
  on main; witnessability for every verify run.
  - Commits: `3e8ed93` (#160), `5a6fc08` (#159).
- **Verify robustness fixes** — `--unidiff-zero` so adapter-emitted zero-context
  hunks apply (`0fff652`, #161); hunk-count clean check counts context lines
  (`3e79636`, #162); missing offline deps is `inconclusive`, never `regressed`
  (`a94426f`, #163); dep-prefetch phase so JS suites can reach `verified`
  (`d412123`, #164).

Also shipped in this window:

- **GLM third-model groundwork (flags OFF)** — shadow-replay dogfood harness that
  judges stored disagreements (#157, `01fc41a`) and a blinded-judge mode for the
  corroborated tier (#158, `20ca41a`). Both behind flags; no roster change yet —
  feeds the open `/about/roadmap` decision.
- **Review consensus hardening** — tolerate Opus 4.7 malformed findings so one bad
  field can't zero a review (#138); retry transient-error degradations to reach
  consensus instead of zeroing (#140). Commits: `422f1ba`, `74762fb`.
- **x402 ops fixes** — job expiry honors `X402_MAX_TIMEOUT_SECONDS` at runtime
  (`43c0ee7`); fleet reviews no longer killed at 30s (route `maxDuration` raised,
  `91adec6`).
- **Onboarder** — README badge snippet included in the welcome issue (B6).
  - Commit: `3e484f9` (#155).
- **Social surface** — post-draft queue: DB sink + operator drain surfaces (#150);
  voice pass making every draft body post-ready (#154). Commits: `26b25f5`, `3ec78dd`.
- **Outgoing-PR poll hygiene** — poll rows whose upstream repo 404s are retired
  (`unreachable`) instead of re-polled forever; row preserved as evidence.
  - Commit: `9ef2dcf` (#149).

## 2026-07-10 — Patch Agent generation fixes + AntSeed dogfood

- **Verifier-first patch gate (#131)** — cross-model patch agreement is now a
  confidence label (`unanimous` / `single_model`), not a ship veto. A lone
  structurally-valid patch ships; the deterministic `patch-verifier` is the
  real gate. Recovers single-model patches that used to die as
  `models_disagreed`.
  - Commit: `9e23e6b` (#131).
- **Stop hallucinated patches (#132)** — `buildPatchPrompt` now embeds a real
  source window (±40 lines) with a copy-old-side-verbatim rule; always-on
  apply-floor rejects patches whose old-side can't be located
  (`patch_apply_failed`).
  - Commit: `5115d83` (#132).
- **AntSeed dogfood** — two-model review of [AntSeed/antseed](https://github.com/AntSeed/antseed)
  via `bench-antseed`. 3/4 findings re-verified real (1 possibly intentional,
  1 debatable). Test-verified upstream fix PRs:
  [AntSeed#727](https://github.com/AntSeed/antseed/pull/727) (chain-config),
  [AntSeed#728](https://github.com/AntSeed/antseed/pull/728) (proxy headers).
  Agent page: `/agents/0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263`.
  Report: `docs/demos/antseed-dogfood-2026-07.md`.
- **Follow-ups** — verify-by-default (#133: fork-standardize bench + repro
  tests); review-stage stochastic recall (separate issue).

## 2026-06-25 — Cyber tier (repo-scoped Daybreak embargo path)

- **`ANTFLEET_CYBER_TIER` flag** — repos classified as cyber-sensitive route through
  an operator-controlled embargo path: public receipts are suppressed, the anatomy
  page returns a holding notice, and disclosure timers are gated by an
  HMAC-signed admin route at `/admin/repo/[slug]`. `DISCLOSURE_HMAC_SECRET` +
  `OPERATOR_SECRET` required in prod. A contract test
  (`cyber-tier-visibility.contract.test.ts`) asserts no cyber finding leaks via
  `/digest`, `/scorecard`, RSS, sitemap, or OG metadata; the test caught a real
  leak surface in the weekly-digest path during pass-3.
  - Final Daybreak engineering item.
  - Commit: `2f1bd92` (#106).

## 2026-06-24 — SARIF ingest/export + Code Scanning push

- **SARIF 2.1.0 ingest** — `POST /api/v1/sarif/ingest` accepts SARIF runs from
  external scanners under an HMAC-signed mint flow, normalizes them into the
  same `agent_findings` shape the two-model gate produces, and bills via the
  prepaid channel. The mint CLI generates per-tool ingest tokens, GC'd hourly
  by the `sarif-token-use-gc` cron.
- **SARIF export + GitHub Code Scanning push** — every finding now has a SARIF
  surface (`GET /api/v1/findings/[id]/sarif`) and live-protocol findings push
  to the upstream repo's Security tab via the Code Scanning API. Verified live
  on `aeon-bench` analysis_id 1399922392 (26 results). Non-live-protocol
  findings export with `state='none'` so they're consumable without leaking
  disclosure timing.
  - Requires a **Classic PAT** with `security_events` scope (fine-grained PATs
    are blocked at the AntFleet org level).
  - Migrations: `0045` (sarif tokens), `0046` (sarif runs), `0047` (export
    state). All applied to prod `ep-crimson-hall-aq6bfx9d`.
  - Commits: `e31ec4c` (#103) → `84c9c94` (#104) → `79e8651` (#105).

## 2026-06-23 — Daybreak (reachability + patch verify + threat model + evidence bundle + disclosure machine)

- **Reachability + patch-verify gates** behind `ANTFLEET_REACHABILITY_GATE` and
  `ANTFLEET_PATCH_VERIFY`. The reachability gate prunes findings whose
  unsafe value isn't reachable through traced call sites before they hit the
  unanimous-agreement bar (closes the [[two-model-consensus-semantic-gap]]).
  The patch-verify gate refuses to publish a proposed patch unless a
  deterministic replay confirms the diff actually neutralizes the finding.
  - Commit: `88d01e7` (#98).
- **Evidence bundle on public receipts** — the anatomy page now surfaces a
  three-slot bundle (PoC, repro instructions, reachability trace) alongside
  every published finding. Empty slots render as "not provided" rather than
  hiding the affordance, so missing evidence is visible.
  - Commit: `9ccb6b1` (#99).
- **Persisted per-repo threat models** — the reachability gate no longer
  re-derives the threat model on every review; it reads from a persisted
  `repo_threat_models` row, regenerating only when the codebase fingerprint
  drifts. Cuts gate latency and stabilizes verdicts across re-runs of the
  same PR.
  - Commits: `b54dbae` + `d821b59` (#100).
- **Disclosure state machine** — `ANTFLEET_DISCLOSURE_GATE` puts every finding
  through `none → embargoed → published` transitions; the public receipt
  short-circuits to a coordination notice while embargoed. Migration `0044`
  adds disclosure columns; the backfill closed 115 legacy rows to `state='none'`
  in a single batch on prod (`ANTFLEET_DISCLOSURE_BACKFILL_COMPLETE=true`).
  - Commit: `6b0a714` (#101); deploy: `843b53c`.

## 2026-06-14 — Provider hardening (GPT-5 budget, neon-serverless transactions)

- **GPT-5 reasoning budget fix** — GPT-5 was returning empty content under
  reasoning-token starvation on ~9.7k-token prompts. Switched the OpenAI
  client to `max_completion_tokens` and raised the budget; consensus matcher
  now falls back to path-only matching when GPT-5 reports null line numbers
  (Opus + GPT-5 disagreed on line:column even when they agreed on the
  finding).
  - Commits: `a14aace` (#90), `fdd7677` (#91).
- **`@neondatabase/serverless` driver for transactions** — the webhook
  pipeline needs Postgres transactions; the previous `neon-http` driver
  couldn't open them, which the audit M-series caught. Drop-in swap.
  - Commit: `c307d00` (#92).

## 2026-06-13 — SPEC-001 audit closeout (M0 → M3)

- **M0 safety net** — paywall money-movement suite hits real Postgres
  (no mocks, per [[feedback_two_model_consensus_semantic_gap]]); webhook
  route-level tests cover signature, parsers, and billing invariant;
  dev-DB split runbook + `.env.example` clarified.
  - Merge: `378f81c` (#85).
- **M1 critical fixes** — per-authorization x402 replay guard on the review
  rail (T1.6); drizzle-kit retired in favor of the hand-applier path (T1.4,
  see [[neon-serverless-1x-sql-query]]).
  - Merge: `2e821ec` (#86).
- **M2 high-leverage** — bounded public queries (no more unbounded scans on
  the homepage), rate limiter, alert sink, x402 convergence, sting decision
  recorded.
  - Commit: `34d835f` (#87).
- **M3 quality & polish** — the sweeper now closes findings only when the
  evidence line range was actually touched by the upstream diff (Option B,
  T3.3); migration `0040` reconciles `0008`; CLI robustness pass; 62/64
  `_*.ts` one-shot scripts deleted.
  - Commits: `ad3dcfe` (#88), `b597a8b` (#89).

## 2026-06-03 → 2026-06-12 — ACP receipt-backed reviews, label axis, retros, KPI strip

- **ACP receipt-backed review intake** (#81) — accept Virtuals ACP review work
  through the AntFleet worker via the receipt-backed provider flow; gates ACP
  intake abuse before any budget is debited; listing made compatible with
  the Virtuals dashboard.
- **Label axis on findings** (#75 → #78) — every finding now carries a
  `blocking | nit | optional | fyi` label; label rules tightened to hard
  MUST constraints after soft-preference language caused models to drift
  (see [[antfleet-label-rules-soft-vs-hard-constraint]]).
- **Patch Agent diagnostics** (#77) — per-side patch skip reasons persist for
  provider diagnostics; `PatchDecision.skipReason` renamed to `gateOutcome`
  to clarify gate-output verdict vs. failure reason.
- **Retro case studies** — Zcash Orchard counterfeiting (#74; reframed as
  class hit, not direct hit); n8n-workflows CVE-2025-55526 (#79).
- **Cross-page KPI strip** — `/impact`, `/scorecard`, `/activity` now lead
  with patches-landed and median time-to-fix as the public KPIs.
  - Commits: `4118de8`, `602b136`.
- **x402 pay-per-scan** — `POST /api/v1/scan/x402` opened to any buyer;
  aeon-only gate removed.
  - Commit: `ffea2df` (#73); docs: `9ff811b`.

## 2026-05-30 — Regression-fixture cron, retraction surface, Patch Agent cost, Onboarder examples

- **Weekly regression-fixture cron** — six curated, known-safe code patterns
  (Rust `unsafe`, TypeScript eval, Solidity selfdestruct, JS prototype-freeze,
  checksummed curl|sh, Python subprocess) run weekly through the live two-model
  gate. If the unanimous gate fires on a safe fixture, the cron returns 500 and
  triggers Vercel alerting — silent model drift gets caught before maintainers do.
  - Fixtures live in `lib/__regression_fixtures__`; runner in `lib/regression-fixtures-cron`.
  - Commit: `26388f2` (#66).
- **Anatomy retraction surface** — operator endpoint `POST /api/admin/retract/[findingId]`
  marks a finding retracted. The anatomy page short-circuits to a retraction notice
  with `robots: noindex` so stale SERP snippets can't keep advertising a false positive.
  Schema migration 0030 adds `retracted_at`, `retraction_reason`, `retraction_email` to
  `finding_status`; normal (non-retracted) pages are byte-identical.
  - Commit: `bbbeddc` (#65).
- **Patch Agent cost wired** — `cost_patch_usd` on the `reviews` table now reflects real
  per-call token usage (input + output) priced at the Anthropic/OpenAI list rates.
  Reconciliation cron backfills rows whose cost was written as 0 before this sprint.
  - Commit: `6f2c355` (#64).
- **Onboarder welcome with real firing examples** — the welcome issue now shows three
  verbatim HIGH-severity public findings (allowlist false-positive, spend-cap bypass,
  curl|sh supply-chain) under "What a finding looks like," and explains that silence on
  a PR means the two models did not reach unanimous agreement, not a broken webhook.
  - Commit: `ffc3927` (#63).

## 2026-05-29 — x402 pay-per-review + SPEC-001 audit closeout

- **x402 pay-per-review without channel onboarding** — public repos can now trigger a
  review via `POST /api/v1/review/x402` with a USDC payment signature. No GitHub App
  install required; no prepaid channel; one-call settlement. Restricted in v1 to
  aeon-ecosystem callers; broader access planned for v2. The homepage agent prompt and
  `/.well-known/antfleet.json` manifest updated to make x402 the default public-repo
  path and reserve channel language for private/installed repos.
  - Commit: `e4475b8`.
- **SPEC-001 v0.6 audit closeout** — x402 v1 and v2 fix passes verified; SPEC-001
  promoted from draft to build-ready. Spec discipline introduced in `.claude/specs/`.
  - Commit: `04b3de6`.

## 2026-05-27 — Absorbed-inline closure detection

- **Absorbed-inline receipt path** — when an outgoing PR is closed without merge, an
  LLM judge (`claude-opus-4-7`) compares the PR diff against recent upstream commits.
  Matches above 0.7 confidence are classified `closed_absorbed` and earn a
  cross-repo receipt. Schema migration 0026 adds `closure_method`, `closure_sha`,
  `closure_detected_at`, `closure_confidence`, `closure_notes` to `outgoing_prs`.
  `/receipts`, `/impact`, homepage, and RSS feed updated to show both merged and
  absorbed-inline rows; the "fix absorbed" badge distinguishes them.
  - Commit: `ec3d8aa`.

## 2026-05-22 — Patch Agent v1.5 + on-demand review API

- **Patch Agent v1.5 (end-to-end)** — every unanimous finding now triggers parallel
  patch proposals from both frontier models. The agreement gate selects the winning
  patch; the sweeper acceptance pass checks the PR for adoption. Per-install override
  via `installations.patch_agent_enabled` lets partners opt out without a flag change.
  Schema migration 0019.
  - Commits: `166ff78` (#39) → `d02a27a` (#40) → `532553c` (#41) → `84518a4` (#42) →
    `22a1bf0` (#43) → `07220fa` (#44) → `f225632` (#45).
- **On-demand review endpoint for Aeon (Phase 1)** — `POST /api/v1/installations/{id}/review`
  with EIP-191 challenge signature triggers a synchronous two-model review and returns
  findings inline. Debits the existing prepaid channel via the same atomic CAS the
  webhook uses; no new payment surface.
  - Commit: `2184a45` (#48).

## 2026-05-21 — Wallet-bound paywall MVP

- **Wallet-bound paywall schema** — `installations`, `channels`, and `payments` tables
  form the prepaid-USDC ledger. `balance_usdc` draws down via `UPDATE … WHERE balance >= price`,
  preventing overdraft under concurrent webhooks. `legacy_partner` flag bypasses the
  gate for existing approved installs.
  - Migration: `0018` (wallet-bind) + related indices.
  - Commit: `927b3f2` (#31).
- **`/v1/installations` state-machine** — agent-readable endpoints for the full install +
  deposit + bind flow. `GET /v1/installations/{id}` exposes the paywall state in a single
  JSON object any autonomous agent can parse without docs.
  - Commit: `fa768cd` (#32).
- **Scan-deposits safety net** — `/api/cron/scan-deposits` reconciles on-chain USDC
  transfers that arrived after a `/deposit` fast-path time-out. Prevents lost deposits.
  - Commit: `285dfd1` (#33).
- **Per-review drawdown gate with x402 invoice fallback** — webhook now checks the
  channel balance before spawning the review worker. Insufficient balance posts an x402
  invoice comment on the PR instead of silently dropping the review.
  - Commit: `900baaa` (#34).
- **Agent-readable surface** — `llms.txt`, `/.well-known/antfleet.json` manifest, and
  homepage agent-prompt section give autonomous callers a machine-readable install and
  payment guide without any human documentation step.
  - Commit: `2ec831d` (#35).
- **`/wallets/[address]` reputation page** — per-wallet view of installs, channel
  balance, and payment history for the bound address.
  - Commit: `912ee53` (#36).
- **Per-file review cap raised to 80 KB** — previous 20 KB limit silently truncated
  large files; the new 80 KB cap with unified-diff fallback for oversize files ensures
  the reviewers always see the full relevant context.
  - Commit: `30f8bca`.

## 2026-05-20 — Operator gate for GitHub App installs

- **Installations approval gate** — every GitHub App install now lands in an
  `installations` table with `pending_approval` status. No PR review fires
  until the operator explicitly approves the (installationId, repo) pair.
  Stops unsolicited reviews on arbitrary repos that install the App.
  - Migration: `0016_installations_gate.sql`.
  - CLI: `scripts/list-installs.ts`, `scripts/approve-install.ts`,
    `scripts/reject-install.ts`.
  - Commit: `5f9bde7` (#31).
- **`/roast` unified** — the public `/roasts` listing and the submission
  form now live on one page at `/roast`; `/roasts` 307s there. Submission
  counter fires on `totalSubmissions > 0` rather than published-only,
  so queued repos surface immediately.
  - Commit: `6f5530c`.

## 2026-05-19 — X-attention sprint (distribution surface)

- **OG cards** — `/receipts/[id]`, `/agents/[address]`, and
  `/digest/[yyyy-mm-dd]` now emit fully-rendered `og:image` cards so
  link previews work on X, Telegram, Slack, and Discord. Generated via
  Next.js `opengraph-image.tsx` routes; no third-party service.
  - Commit: `92a0bcb` (#30).
- **Tweet intent links** — every receipt and agent finding page exposes a
  pre-filled `twitter.com/intent/tweet` link so the operator can share
  findings with one click.
  - Commit: `92a0bcb` (#30).
- **Weekly digest at `/digest/[yyyy-mm-dd]`** — server component
  rendering the week's benchmark and receipt highlights with its own OG
  card.
  - Commit: `92a0bcb` (#30).
- **`/activity` counters gated on `public_receipt`** — the headline
  "receipts closed all-time" counter previously summed all installs
  including non-opted-in dogfood rows. Now joins `finding_status` and
  filters `status='closed'` on rows where `public_receipt=true`, so
  the number matches what `/receipts` actually shows.
  - Commit: `92a0bcb` (#30).
- **Receipt-of-the-week moved above the fold** — the `ReceiptOfTheWeek`
  card sits immediately below the Hero; static mock dropped, live data
  only.
  - Commit: `ddaea66` (#29).
- **autonomopoly PRs #3 + #4 merged** — the two upstream fixes opened by
  `antfleet-ops` on `Liquid-Protocol-Ops/agent-autonomopoly` (threshold
  harmonization + Husky prepare fix) merged at `3299eed` and `fb5509c`.
  First confirmed cross-repo receipts.

## 2026-05-18 — Sprint 5 (public API + weekly curator)

- **`/api/v1` public JSON API** — seven GET endpoints covering findings
  list/detail, agents list/detail, agent-scoped findings, agent-scoped
  drift, and stats. Cursor pagination via base64url JSON tuples.
  Explicit-key serializers prevent internal columns from leaking.
  - Commit: `56cceaf` (#27).
- **Weekly auto-curator cron** — `lib/curate-weekly.ts` ranks by
  `severity → upstream_pr → merged → recency` and inserts the week's
  feature finding idempotently. `vercel.json` schedules it at
  `0 0 * * 1` (Monday 00:00 UTC). Manual override still available via
  `scripts/curate-weekly.ts`.
  - Commit: `d2bf884` (#28).

## 2026-05-18 — Sprint 4 (operator portal + receipt of the week)

- **Operator portal** (`/agents/[address]/claim`) — agent deployers claim
  a repo via EIP-191 personal-sign. Signature recovery, 10-min window,
  3-per-token-per-7d rate limit. Replay-within-window returns 200;
  concurrent-claim race is idempotent.
  - Migrations: `0013` (agent_claims), `0014` (weekly_features),
    `0015` (unique indexes).
  - Commit: `09ec131` (#25).
- **Roast moderation pipeline** — all `/roast` submissions gate behind
  operator promote; `scripts/promote-roast.ts` drives the transition
  from queued → published. Operator can reject with a reason.
  - Commit: `c8557cd` (#24).
- **Durable review queue (Mission 7)** — the webhook now inserts a stub
  `reviews` row before dispatching `after()`, making the row the queue
  entry itself. A `/api/cron/review-retry` cron rescues any row whose
  `processingStatus` is not `done` after the first attempt (exponential
  backoff). Fixes the 10/30-review loss on `aeon-bench` from the
  2026-05-18 burst.

## 2026-05-17 — First production receipt

- **First public receipt landed** on `/receipts`. Closure SHA `4640404a`
  on `Augustas11/antfleet` PR #3, closing a Security/High info-disclosure
  finding flagged unanimously by both reviewers in 36s.
  - Authored by: Reviewer Fleet (`claude-opus-4-7` + `gpt-5`) agreed →
    Agreement Gate emitted → Sweeper detected closure → posted receipt.
- **Webhook budget bumped** from 60s → 300s (Pro plan ceiling) after the
  first production smoke test (`Augustas11/antfleet` PR #1) timed out
  mid-review on a 5-file diff.
  - Commit: `74efb58` (#2).
- **Production secrets pushed.** GitHub App credentials + LLM API keys
  populated in Vercel via `scripts/push-prod-env.ts`. The same pattern
  applies for future credential rotations.
- **Canonical domain `www.antfleet.dev` live.** Apex 307s to `www`.
  `metadataBase` set so OG metadata resolves against the canonical origin.
- **Architecture, changelog, and receipt-detail pages shipped.** This
  page, `/architecture`, and `/receipts/<id>` went live alongside the
  domain switch.

## 2026-05-17 — Mission 4 complete (public surface)

- **`/receipts` polish + opt-in gate** — cursor pagination, last-updated
  stamp, and a `reviews.public_receipt` boolean column gating which closed
  findings reach the public page. New installs are private by default
  (request via `privacy@antfleet.dev` until the v1.5 dashboard ships).
  - Commit: `21c796d`.
- **`/policy` page** — plain-English data policy in seven sections.
  - Commit: `15a94a5`.
- **`/receipts` first ship** — server component reading `finding_status`
  joined to `reviews`, anonymized repo labels, 50-row default.
  - Commit: `12f0e56`.
- **Landing page `/`** — hero, ProofSection, FeatureGrid, HowItWorks,
  TrustSection with the honest RED on recall, BottomCta. Copy follows the
  §15 architectural frame.
  - Commit: `62acc77`.
- **Chrome scaffold** — Tailwind v4, brand tokens, Inter Variable +
  JetBrains Mono Variable via `next/font`.
  - Commit: `cfcbf1e`.

## 2026-05-16/17 — Mission 3 complete (sweeper + receipt lifecycle)

- **Daily cron schedule** (`vercel.json`) wires `/api/cron/sweep` to fire
  at 06:00 UTC.
  - Commit: `75ff270`.
- **Sweep orchestrator** — `/api/cron/sweep` route + `runSweep` +
  `loadSweepWork` query. Dependency-injected internals so the pipeline is
  unit-testable.
  - Commit: `58043da`.
- **Reaction polling** — `pollReactions` + `mapToMaintainerReactions`,
  dedup unique index on the reaction tuple.
  - Commit: `a63adde`.
- **Closure receipt formatter** — `formatClosureReceipt` produces the
  "AntFleet · finding X closed in Y" comment body.
  - Commit: `a9b842a`.
- **Closure detection primitives** — `classifyFindings` (pure decision
  function) + `detectClosures` (wired). Heuristic: "evidence file changed
  between `review.commit_sha` and main HEAD" = closed.
  - Commit: `79c7a55`.
- **`finding_status` table** — one row per agreed finding; the sweeper
  reconciles, the reaction poller stamps.
  - Commit: `63af2e2`.

## 2026-05-16 — Mission 1 complete (review pipeline)

- **End-to-end demo** — live PR review on `Augustas11/krisskross_shops`
  PR #1: webhook → 2-of-2 unanimous review → markdown comment.
- **PR comment posting** via Octokit installation token.
  - Commit: `ed6c971`.
- **Anthropic + OpenAI parallel review pipeline.**
  - Commit: `6053efe`.
- **Agreement gate** — degraded mode = no comment.
  - Commit: `be9704d`.
- **GitHub App auth, webhook handler, stub-row dispatcher.**
  - Commit: `ed152e0`.
- **Webhook HMAC verification + structured logging.**
  - Commit: `673f995`.
- **Next.js 16 + Drizzle schema scaffold.**
  - Commit: `c75f187`.

## 2026-05-15 — Phase 0 + fork

- **Phase 0 verdict** — V2 + V3 spike runs on the real-repo baseline
  corpus settled the pitch as "precision, not coverage." The receipt
  corpus guarantees what we post; recall against a curated bug list is
  not the promise.
- **Fork base** — Forked from
  [openclaw/clawpatch@b03bf52](https://github.com/openclaw/clawpatch/commit/b03bf5200a7348165bca96dd1a89008ed718b25f).
  Inherited slicer, finding schema, workflow, and state-engine primitives.
  Diverged from upstream at fork point; do not track upstream after.

---

## Lineage from clawpatch upstream

These entries describe features that landed in `clawpatch` prior to our
fork point. AntFleet inherited the underlying review primitives but
diverges from the project shape (b2b GitHub App + receipts moat vs OSS
CLI dev tool). Kept here for provenance.

- Added Next.js route mapping for `src/app` and `src/pages` layouts.
- Added first-pass Python mapping for project metadata, console scripts,
  source groups, pytest suites, and conservative validation defaults.
- Improved Node/TypeScript mapping for large workspaces by splitting
  package source trees into bounded review groups with package-local
  tests.
- Added generic nested SwiftPM, Apple/Xcode, and Gradle/Android app
  mapping.

### clawpatch 0.1.0 — 2026-05-15

- Added the initial strict TypeScript `clawpatch` CLI scaffold with
  `init`, `map`, `status`, `review`, `report`, `fix`, `revalidate`,
  `doctor`, and `clean-locks`.
- Added feature-centered state, Codex CLI provider integration, strict
  provider schemas, tests, docs.
- Added SwiftPM and Rust/Cargo project detection, default commands, and
  deterministic feature mapping.
- Improved Go package mapping, review progress, parallel review jobs,
  report filtering, finding triage, and file/line evidence output.
- Added finding queue commands, triage history, bulk revalidation
  filters, and stricter review evidence/test-analysis fields.

---

This changelog is maintained by hand and committed alongside substantive
shipments. The live `/receipts` page carries the agent-produced artifacts
in real time — the changelog records the operator-shaped shipments.
