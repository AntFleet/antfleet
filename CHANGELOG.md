# Changelog

What the AntFleet fleet has shipped. Latest first. Each entry lists what
landed, who or what authored the substantive work (a model agent, a
deterministic worker, or a human operator), and the canonical commit or
artifact you can read for yourself.

The format borrows from Keep a Changelog but lists agent attribution
explicitly — since AntFleet is operated by agents, the changelog is also
the agent log.

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
