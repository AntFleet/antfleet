# AntFleet Dogfood — Virtuals Protocol Agent Benchmark

**Brief type**: OMC autopilot execution brief
**Draft date**: 2026-05-24
**Status**: Drafted, pending operator review before firing
**Predecessor**: `docs/demos/dogfood-three-benchmarks-report.md` (agent-autonomopoly bench, 2026-05-18)

---

## Goal

Execute the second-ecosystem dogfood that substantiates AntFleet's "universal code-review layer for tokenized agents" positioning. Successful run = bench fork at `antfleet/<virtuals-agent>-bench`, ≥3 replay PRs reviewed end-to-end by both models, consensus findings published as receipts on antfleet.dev (or honestly reported if zero), upstream fix PRs opened from `antfleet-ops` identity for any high-confidence findings, and a content artifact ready for X.

This is the *second* ecosystem in a planned multi-ecosystem narrative. The first (agent-autonomopoly) shipped `antfleet/agent-autonomopoly-bench` with PRs #3 and #4 merged upstream. This run extends the pattern to Virtuals Protocol so the universal-layer narrative is defensible with two-ecosystem receipts, not one.

## Hard constraints

### Identity

- **All writes to `antfleet/*` use the `antfleet-ops` gh account**: `gh auth switch --user antfleet-ops` before any push, PR, or repo creation.
- **All upstream fix PRs use the `antfleet-ops` identity** with commit metadata `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>`. Never `Augustas11`. Never `ops@antfleet.dev` as committer email (the noreply email links to the GitHub user; `ops@antfleet.dev` does not).
- **Never use the Augustas11 GitHub identity** for any AntFleet-org write.

### Brand voice

- This is the **AntFleet** brand. Do **NOT** use Colony Scout / `@AntFeed` voice anywhere. AntFleet voice is direct, technical, evidence-first, no lowercase aesthetic.
- All public-facing copy (X post, README badges, PR bodies) should be in AntFleet voice.

### Sources of truth

- Canonical AntFleet repo: `github.com/antfleet/antfleet`. Never `Augustas11/antfleet`.
- For Virtuals Protocol facts, source ONLY from the official GitHub org (verify per query) and the live virtuals.io site. Do NOT source from any `.pro`, `.xyz`, or lookalike domain unless explicitly user-confirmed.
- Treat `autonomopoly.pro` and any similar Liquid-ecosystem lookalike as scam/spoof — do not cite, do not link.

### Verify-before-claim

- After every push to antfleet/* run `vercel ls --prod` (per memory) to confirm auto-deploy succeeded. Don't assume.
- Production DB writes and `gh pr merge` to main require explicit `i authorize` in chat from the operator before execution.

## Phase 0 — Target discovery (30-60 min, parallel-safe)

**Output**: a target selection memo with primary + 2 backups.

Research tasks (run in parallel):

1. **Map the Virtuals Protocol GitHub footprint**. Find the official org. Identify which repos under it (or owned by their team) represent canonical agents — equivalent to how `Liquid-Protocol-Ops/agent-autonomopoly` is canonical for Liquid.

2. **Score each candidate** on:
   - Public, active (commits in last 30 days)
   - Real code surface — `.ts`, `.tsx`, `.js`, `.json`, `.md`, `.yml` (Mission 6 extensions are now in scope)
   - Diff complexity — substantive commits, not just lockfile/version bumps
   - Notable engineering decisions (financial logic, on-chain interactions, agent orchestration, secrets handling) — same things AntFleet is good at flagging
   - License compatible with public mirroring (most are MIT/Apache, but verify)

3. **Select primary target + 2 backups**. Document why. If no Virtuals canonical agent is suitable, fall back to a well-known open-source agent framework (e.g., a popular agent SDK or AI tool with active development).

**Stop condition**: if you cannot identify a viable Virtuals target after 60 min of research, surface findings to operator and ask for direction. Do NOT proceed to Phase 1 with a weak target.

## Phase 1 — Fork + bench setup (under `antfleet/` org)

For the selected target:

1. **Verify auth** as `antfleet-ops`.
2. **Create bench fork**: `antfleet/<target-name>-bench` (matching `antfleet/agent-autonomopoly-bench` naming).
3. **Configure as benchmark**:
   - Disable Issues, Wiki, Projects, Discussions (read-only mirror).
   - Set description: `"Public benchmark mirror for AntFleet. Not maintained. Real project: github.com/<original-org>/<original-repo>"`
   - Add `BENCHMARK.md` at root (template from `antfleet/agent-autonomopoly-bench` — explains the purpose, points to canonical upstream, disclaims maintenance).
4. **Install antfleet[bot] GitHub App** on the bench repo (via antfleet-ops, will likely require manual operator step in browser — flag this when reached).
5. **Configure DB row** for the installation as `legacyPartner` so reviews trigger end-to-end (same as autonomopoly bench).
6. **Smoke test**: open a trivial chore PR, verify webhook delivery → review pipeline → review-skipped or review-completed log line in production. Close PR after verification.

**Stop condition**: if webhook delivery fails or review pipeline doesn't dispatch, halt and surface logs. Do not proceed to Phase 2.

## Phase 2 — Mirror substantive upstream commits as replay PRs

**Target**: 3-5 replay PRs covering diverse engineering surface.

1. **Select commits** from upstream's last 30-60 days. Prefer:
   - At least 1 commit touching financial/on-chain logic (if applicable)
   - At least 1 commit touching agent core logic / orchestration
   - At least 1 commit touching infra (workflows, deployment, secrets handling)
   - Avoid pure dependency bumps unless you want a calibration anchor (one is fine, more is wasted)
2. **For each selected commit**: create a branch on the bench fork, cherry-pick or recreate the diff, open a PR titled with the upstream SHA prefix. PR body should link to the upstream commit.
3. **Wait for each PR to be processed** by antfleet[bot]. Verify in production logs that both models ran and consensus was computed.

**Stop condition**: if any single PR exceeds 80KB total diff size, the unified-diff fallback kicks in (per memory) — verify it activates correctly. If multiple PRs fail to dispatch reviews, halt and investigate.

## Phase 3 — Capture findings + verify public receipts

For each completed review:

1. **Pull the review record from production DB** (review ID, consensus count, agreedCount, degraded flag).
2. **Document each finding** that surfaced: severity, file, line, what the consensus said.
3. **Verify publicReceipt = true** on each row (should default to true for public repos per Mission 5; explicit verification because the bench repo's public-ness needs confirmation).
4. **Verify visibility**: open `antfleet.dev/agents/<bench-owner>` and `antfleet.dev/benchmarks` — bench review should appear. Note: `/receipts` requires `status = 'closed'` (Sweeper-gated, only fires on merge), so bench PRs won't appear there until/unless we merge them. This is expected behavior — `/benchmarks` is the canonical surface for non-merging replay PRs.

**Honest-report gate**: if `agreedCount: 0` on all reviews, **that is a valid outcome**. Write an honest report saying so (per the autonomopoly v1 precedent). Do not invent findings to fill the page.

## Phase 4 — Upstream fix PRs (operator-gated)

For each consensus finding rated HIGH or MEDIUM severity:

1. **Draft a fix PR** against the upstream repo (NOT the bench). Identity: `antfleet-ops`. Branch naming: `fix/<short-description>`.
2. **Body template** (use exact AntFleet voice):

   ```
   Caught by AntFleet during multi-ecosystem benchmark review.
   Bench: github.com/antfleet/<bench-name>/pull/<N>
   Review ID: <id>
   Severity: <HIGH|MEDIUM>
   Finding: <one-line summary>

   Both reviewers (claude-opus-4-7 + gpt-5) flagged this independently. Fix applied here for upstream consideration.

   AntFleet — two-model PR review. github.com/antfleet
   ```

3. **Do NOT auto-submit**. Surface drafts to operator for approval before opening. (User has previously approved PR opens explicitly per PR.)

## Phase 5 — Content artifact for X

Draft an X post in AntFleet voice covering:

- Multi-ecosystem positioning ("AntFleet now runs across <ecosystem-1> and <ecosystem-2>")
- Specific receipts (bench repo URL, consensus finding count, severity breakdown)
- Any upstream fix PR links (if Phase 4 produced them)
- One-line CTA to antfleet.dev/benchmarks

Two variants:

- **Variant A (full)**: 2-tweet thread with findings detail
- **Variant B (short)**: single tweet with bench link + finding count

Do NOT auto-publish. Surface to operator for review.

## Stop conditions (any halt the run)

- Phase 0 fails to identify a viable target (research, don't push weak ones through)
- Phase 1 antfleet[bot] webhook doesn't dispatch
- Phase 2 multiple replay PRs fail to trigger reviews
- High-confidence finding in security-critical code that warrants immediate human review before publication
- Operator says stop

## Output checklist

By end of run, the following should exist:

- [ ] `antfleet/<target-name>-bench` repo, configured per Phase 1
- [ ] 3-5 replay PRs on bench fork, each processed by antfleet[bot]
- [ ] Review records in production DB with publicReceipt=true
- [ ] `antfleet.dev/agents/<bench-owner>` and `antfleet.dev/benchmarks` visibly include the new bench
- [ ] `docs/demos/virtuals-dogfood-report.md` written in same format as `docs/demos/dogfood-three-benchmarks-report.md`
- [ ] Upstream fix PR drafts (if applicable) ready for operator approval
- [ ] X post variants A + B drafted, ready for operator approval
- [ ] Auth identity verified as `antfleet-ops` for all writes
- [ ] Vercel deploys verified after any push (`vercel ls --prod`)

## Run metadata to capture

- Start UTC time, end UTC time
- Total spend (anthropic + openai costs across all reviews)
- Per-PR timings (anthropic ms, openai ms)
- Any production log anomalies (webhook delivery failures, model degradation events)
- Reviewer scope decisions (which extensions actually fired)

---

## Reference — relevant infrastructure state at brief time

(For autopilot's situational awareness; do not blindly trust, verify per query.)

- **GitHub App**: `antfleet[bot]`, installed on `antfleet/antfleet` and `antfleet/agent-autonomopoly-bench`.
- **Reviewer extensions** (after Mission 6): `.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.md`, `.yml`, `.yaml`, `.sol`, `.py` (verify against `apps/web/lib/github-files.ts:REVIEW_EXTENSIONS` at run time).
- **Review size cap**: 80KB per file with unified-diff fallback for oversize (raised 2026-05-21, commit `30f8bca`).
- **Public receipts default**: `publicReceipt = true` for public-repo reviews (Mission 5, 2026-05-18).
- **API surface**: `POST /review` returns `202 + jobId`; `GET /review/{jobId}` polls; refund on `provider_error | timeout | internal` only (API async-default, schema head 0024, 2026-05-23).
- **Operator script for visibility**: `apps/web/scripts/enable-public-receipts.ts` — needed only if bench repo is private or default doesn't fire. Run with `pnpm exec tsx scripts/enable-public-receipts.ts <owner> [<repo>]`.

## Lessons from agent-autonomopoly bench (don't repeat)

1. **v1 had zero findings because REVIEW_EXTENSIONS didn't include `.md` and `.yml`** — that's fixed now. Verify the current extensions list before run to make sure it covers the target's actual code surface.
2. **`/receipts` page is Sweeper-gated** — bench PRs won't appear there because they don't merge. Use `/benchmarks` and `/agents/<owner>` as the visibility surfaces for bench runs.
3. **PR identity matters for upstream merge** — PRs from `Augustas11` got closed and reopened as `antfleet-ops`. Always check active gh account before opening any upstream PR.
4. **80KB cap rescued the cap problem** — before 2026-05-21 some agent-autonomopoly files were skipped. Cap is now 80KB with unified-diff fallback. Should not need additional intervention.
5. **Don't invent findings** — if both models agree on nothing, write the honest report (autonomopoly v1 precedent). The trust signal from "we ran end-to-end and consensus was zero" is real and worth more than fake findings.
