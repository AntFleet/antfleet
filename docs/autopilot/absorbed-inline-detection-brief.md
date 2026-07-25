# AntFleet Sprint — Absorbed-Inline Closure Detection

**Brief type**: OMC autopilot execution brief
**Draft date**: 2026-05-27
**Status**: Drafted, pending operator review before firing
**Predecessor**: PR #5 + PR #8 outcomes on agent-autonomopoly (documented in `docs/demos/upstream-fix-prs.md`) — see "Lessons from predecessor" at the bottom.

---

## Goal

Ship the data model, detection logic, UI surface, and backfill needed to correctly classify upstream fix PRs that get closed-without-merge but whose underlying fix lands on the upstream base branch via a separate commit. Today this category is silently mis-classified as `closed` (declined), which under-counts AntFleet's signal value by ~50% on the agent-autonomopoly receipts.

By end of sprint:

- `outgoing_prs` schema has first-class `closureMethod`, `closureSha`, `closureDetectedAt`, `closureConfidence` columns
- Sweep cron auto-detects absorbed-inline closures via LLM-judged diff equivalence on `closed-without-merge` state transitions
- Backfill correctly identifies PR #5 → `bab1e4b` and PR #8 → `7329b8a` as `closed_absorbed` (reference data already captured in `docs/demos/upstream-fix-prs.md`)
- `/receipts` page renders `closed_absorbed` as a receipt-eligible state with closure SHA + upstream commit link
- README, `/about`, `/receipts` page copy reflects the "findings → fixes" framing (not "PRs merged")
- Production deploy verified via `vercel ls --prod`
- The headline claim becomes defensible by data: **"4 substantive PRs filed on agent-autonomopoly, 4/4 underlying fixes landed within 8 days, AntFleet's signal preceded the fix in 100% of cases."**

## Hard constraints

### Identity

- **All writes to `antfleet/*` use the `antfleet-ops` gh account**: `gh auth switch --user antfleet-ops` before any push or PR.
- Commit identity: `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>`.
- Never `Augustas11`. Never `ops@antfleet.dev` as committer email.

### Brand voice

- AntFleet voice: direct, technical, evidence-first, no lowercase aesthetic, no emoji.
- Do **NOT** use Colony Scout / `@AntFeed` voice anywhere.
- New copy goes through the positioning thesis at `docs/positioning.md` — Layer 1-3 messaging.

### Production database writes

- **The schema migration is a production DB write.** Per memory: prod DB writes need explicit `i authorize` from the operator in chat. The autopilot **must halt at the migration-apply step** and surface for operator approval. Do not apply without the literal `i authorize` token in chat.
- Migration files go in `apps/web/db/migrations/` with naming `0025_*.sql` (verify current schema head is `0024` before generating — per memory).
- Apply pattern (per memory): `pnpm exec tsx apps/web/db/apply-migration-0025.ts --apply`. Dry-run first without `--apply`.

### Verify-before-claim

- After every push to `antfleet/antfleet` run `vercel ls --prod` (per memory) — don't assume deploy succeeded.
- After backfill, verify reference outcomes match exactly: PR #5 must end with `closureSha: bab1e4b`; PR #8 must end with `closureSha: 7329b8a`. If either doesn't match, halt and surface to operator before continuing.
- Test the LLM-judge against known reference pairs before running backfill on full corpus.

### Cost ceiling

- LLM-judge cost ceiling: **$10 total** across all detection runs in this sprint (backfill + new detections + tests). If burn rate suggests exceeding, halt and surface to operator.
- Per-detection budget: ~$0.05 (one `claude-opus-4-7` call per candidate commit; bounded to top-N candidates by recency).

## Reference data (golden test cases)

The manual detection results captured in `docs/demos/upstream-fix-prs.md` are the autopilot's reference data. Successful execution must reproduce these outcomes after auto-detection:

| Outgoing PR | upstream # | Expected closureMethod | Expected closureSha | Expected confidence |
| --- | --- | --- | --- | --- |
| PR 1 (threshold harmonization) | 3 | `merged` | `3299eed8c52f41ed01e1a249c0e6c7b6f4e3c649` | n/a (mergeSha) |
| PR 2 (husky prepare) | 4 | `merged` | `fb5509ce5d31cc108492e1e5b6637253ae0912d2` | n/a (mergeSha) |
| **PR 3 (FeeLocker selector)** | **5** | **`absorbed_inline`** | **`bab1e4b`** | **≥0.7** |
| **PR 4 (token0<token1 ordering)** | **8** | **`absorbed_inline`** | **`7329b8a`** | **≥0.7** |

If the LLM-judge produces different closureSha values for PR #5 or PR #8, the detection is broken — halt and surface.

## Phase 0 — Pre-flight verification (≤30 min)

1. **Auth check**: confirm `gh auth status` shows `antfleet-ops` as active.
2. **Schema head check**: query Neon — `SELECT version FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 1;` — must equal `0024`. If different, halt.
3. **outgoing_prs snapshot**: count rows by `status` — capture current state for backfill validation. Expected: at least 2 rows in `closed` status (PR #5 + PR #8 will be there once cron sweep runs against the just-closed PRs; verify they exist or wait for one sweep tick).
4. **Reference data verification**: read `docs/demos/upstream-fix-prs.md`. Confirm the four reference rows are present with the closure SHAs above.
5. **Cost tracking infra**: confirm provider-cost logging (`provider_costs` or equivalent — check existing review pipeline) is in place and queryable.

**Stop condition**: any pre-flight check fails. Don't proceed with broken assumptions.

## Phase 1 — Schema migration

1. Generate migration `0025_outgoing_prs_closure_method.sql` adding to `outgoing_prs`:
   - `closure_method text` (nullable)  — `merged | absorbed_inline | declined | stale_timeout`
   - `closure_sha text` (nullable) — upstream commit SHA that applied the fix (whether via our PR or theirs)
   - `closure_detected_at timestamptz` (nullable)
   - `closure_confidence real` (nullable) — `0.0..1.0`
   - `closure_notes text` (nullable) — LLM-judge reasoning, useful for audit

2. Update Drizzle schema in `apps/web/db/schema.ts` `outgoingPrs` definition with matching fields.

3. Generate the apply script: `apps/web/db/apply-migration-0025.ts` mirroring the existing `apply-migration-XXXX.ts` pattern.

4. **Halt and surface to operator** with the migration SQL printed in chat. Operator must respond with `i authorize` before the autopilot runs `pnpm exec tsx apps/web/db/apply-migration-0025.ts --apply`.

5. After apply: re-query `__drizzle_migrations` to confirm head is `0025`. Re-query `outgoing_prs` columns to confirm new fields exist.

**Stop condition**: operator does not authorize the migration apply. Brief halts; resume later by re-running Phase 1 step 4 once authorized.

## Phase 2 — Sweeper LLM-judge detection

1. Locate existing sweep logic: `apps/web/lib/sweep.ts`, `apps/web/lib/sweeper.ts`, `apps/web/lib/sweep-data.ts`. Understand the current `pollOutgoingPrs()` flow and where state transitions are handled.

2. Add a new function `detectAbsorbedInline(pr: OutgoingPr): Promise<AbsorbedInlineResult>`:
   - **Input**: an `outgoing_prs` row that just transitioned to `closed` (closed-without-merge state).
   - **Step 2.1**: Fetch our PR's diff from GitHub (`pulls.get` with `mediaType: { format: "diff" }`).
   - **Step 2.2**: Fetch candidate commits on the upstream base branch since `pr.openedAt`. Use `repos.listCommits` filtered by `since`. Cap to top 20 by recency to bound cost.
   - **Step 2.3**: For each candidate, fetch its diff. Pre-filter by file-overlap heuristic — if no overlapping file paths, skip the LLM call (cheap optimization).
   - **Step 2.4**: For each candidate that passed the filter, call `claude-opus-4-7` with structured output:
     - System: AntFleet absorbed-inline judge. Strict criterion: did this commit apply the same fix as the PR? Bundled adjacent work is OK; pure coincidence on file paths is NOT a match.
     - Input: PR title, PR body, PR diff, candidate commit message, candidate commit diff.
     - Tool/structured output: `{ equivalent: boolean, confidence: number 0..1, reasoning: string (≤200 chars) }`.
   - **Step 2.5**: Return the highest-confidence match above threshold `0.7`. Return `{ absorbed: false }` if no candidate clears threshold.

3. Integrate into the cron sweep. When `pollOutgoingPrs` detects a `closed-without-merge` transition:
   - Call `detectAbsorbedInline()`.
   - If absorbed → set `status='closed_absorbed'`, populate closure fields.
   - If not absorbed → set `status='closed'` (= `declined`), set `closureMethod='declined'`, `closureDetectedAt=now`.

4. Honest-report gate (critical): **when in doubt, classify as `declined`, not `absorbed_inline`**. False positives on absorption damage the "AntFleet preceded the fix" claim more than false negatives. Threshold of `0.7` is deliberately conservative — operator can manually override via the reference doc.

5. Cost tracking: log per-detection cost to provider cost table. Surface running total during execution.

**Stop condition**: the LLM-judge cannot distinguish PR #5/#8 (known absorbed) from a control case (use a synthetic "PR closed but no related commit" to verify it returns `absorbed: false`). If the judge gives high confidence to obviously wrong matches, the prompt needs work — halt and surface examples.

## Phase 3 — Backfill historical closed rows

1. Create script: `apps/web/scripts/backfill-absorbed-inline.ts`.
2. Reads all `outgoing_prs` rows with `status='closed'` and `closureSha IS NULL` (haven't been processed yet).
3. For each row, calls `detectAbsorbedInline()`.
4. Updates the row with results.
5. Produces a report: total rows processed, # absorbed, # confirmed declined, # ambiguous (low-confidence matches), total LLM cost.
6. Dry-run first (no DB writes) — operator reviews the report before re-running with `--apply`.

**Reference-data validation**: the backfill must produce these exact outcomes:
- PR #5 → `closureSha: bab1e4b`, `closureMethod: absorbed_inline`
- PR #8 → `closureSha: 7329b8a`, `closureMethod: absorbed_inline`

If either row gets a different closureSha or `absorbed: false`, the LLM-judge is broken — halt and surface to operator with the judge's reasoning text.

**Stop condition**: reference-data validation fails. Backfill is not committed; operator inspects judge reasoning, iterates on prompt, re-runs Phase 2 + 3.

## Phase 4 — UI surface update

1. Locate `/receipts` page route: `apps/web/app/receipts/page.tsx` (verify path during execution).
2. Update query to include rows where `status IN ('merged', 'closed_absorbed')` — not just `merged`. Order by `mergedAt OR closureDetectedAt DESC`.
3. Receipt card rendering:
   - For `merged` rows: existing rendering (merge SHA, merged-at, link to upstream merge commit).
   - For `closed_absorbed` rows: render with same card shape but distinguished label — "Fix absorbed" or "Inline absorption" — closure SHA, closureDetectedAt, link to the *upstream commit* that applied the fix (not to the closed PR itself, though optionally link both).
4. Add a small explainer somewhere on the page about the two-state model:
   > *"AntFleet's signal succeeds when the underlying fix lands on upstream — whether via merge of our PR (`merged`) or via a separate upstream commit that applies the same fix (`absorbed_inline`). Both are receipt-eligible."*
5. Update any aggregate counts on the page header to reflect `merged + closed_absorbed` together, not just merged.
6. Optional: filter UI to view only one closure type. Not required for this sprint; flag as deferred work.

**Stop condition**: rendering breaks for existing `merged` rows (regression). Roll back UI changes immediately.

## Phase 5 — Copy update (positioning alignment)

Cross-reference `docs/positioning.md` Layer 1-3 messaging and update the following surfaces:

1. **`README.md`** (root): no current "X PRs merged" claim per my earlier check — keep the "Two independent frontier models review every pull request..." opening intact. Confirm nothing in the README under-counts via the merge-only framing. If it does, fix.

2. **`apps/web/app/receipts/` page hero**: replace any "merged" headline with "findings → fixes" framing. New header text suggestion:
   > *"Independent code review. Two-model consensus. The receipts are the artifact — every fix that landed on upstream, by any path."*

3. **`apps/web/app/about/` page** (verify path; may live at `/about` or `/policy`): include the two-outcome explainer (per Phase 4 step 4).

4. **BENCHMARK.md template** at `antfleet/agent-autonomopoly-bench` (verify content): if it currently says "PRs merged" or similar merge-only language, update to reflect the broader signal-to-fix framing.

5. **GitHub App description**: verify it's aligned with Layer 1-2 of `docs/positioning.md`. If not, propose updated text and surface to operator for the app metadata change (operator-only, autopilot cannot edit GitHub App metadata).

**Stop condition**: copy changes touch user-visible legal text (`/policy`, terms) — halt and surface to operator. Strategic copy changes are autopilot-scope; legal/policy edits are not.

## Phase 6 — Tests + verification

1. Unit tests for `detectAbsorbedInline()` covering:
   - Known positive case (PR #5 vs bab1e4b)
   - Known positive case (PR #8 vs 7329b8a)
   - Known negative case (a closed-and-truly-declined PR; can be synthetic if no real example exists in the corpus)
   - Edge: PR with no candidate commits in window (empty result, returns `absorbed: false`)
   - Edge: PR with overlapping files but semantically different commits (should return `absorbed: false`)

2. Integration test for the sweep cron transition path. Use a fixture row in test DB.

3. End-to-end manual verification post-deploy:
   - `vercel ls --prod` — confirm latest deploy succeeded.
   - Open `antfleet.dev/receipts` — confirm PR #5 + PR #8 appear as `closed_absorbed` receipts with their respective closure SHAs linked to the upstream commits.
   - Confirm `merged` PRs (#3, #4) still render correctly.

4. Cost report: total LLM spend for this sprint logged + reported.

## Stop conditions (any halt the run)

- Operator does not authorize the production migration apply.
- Reference data validation fails (PR #5 or PR #8 doesn't get the expected closureSha).
- LLM-judge cannot distinguish absorbed cases from declined cases at >70% confidence.
- Cost ceiling ($10) exceeded.
- UI rendering regresses existing `merged` rows.
- Vercel deploy fails after push.
- Schema migration apply errors out mid-flight.
- High-severity finding emerges in code review of the new sweep logic (e.g., LLM-judge produces high-confidence false positives on the test set).

## Output checklist

- [ ] Migration `0025_outgoing_prs_closure_method.sql` applied to production
- [ ] Drizzle schema in `apps/web/db/schema.ts` updated and committed
- [ ] `detectAbsorbedInline()` function shipped in sweep module
- [ ] Sweep cron integration: `closed-without-merge` transitions invoke detection
- [ ] Backfill script committed in `apps/web/scripts/`
- [ ] Backfill executed with `--apply`; PR #5 + PR #8 rows correctly reclassified
- [ ] `/receipts` page renders `closed_absorbed` receipts with closure SHAs
- [ ] Receipts page explainer text added (two-state model)
- [ ] Aggregate headline metric reflects `merged + closed_absorbed` together
- [ ] Copy updates landed across README / about / receipts hero (per Phase 5)
- [ ] Unit + integration tests passing
- [ ] Production deploy verified via `vercel ls --prod`
- [ ] Manual verification: PR #5 + PR #8 visible on antfleet.dev/receipts
- [ ] Cost report logged
- [ ] `docs/demos/upstream-fix-prs.md` schema-gap note removed (Phase 1 closed the gap)

## Run metadata to capture

- Start UTC time, end UTC time
- Total LLM spend (claude-opus-4-7 calls + provider mix)
- Per-row backfill timings
- Reference-data validation results (with judge reasoning text for each)
- Any production log anomalies (sweep cron errors, deploy errors)
- Files changed and their sizes (for cost-of-deploy estimation)

---

## Reference — current schema state at brief time

(Autopilot should verify per query; do not blindly trust.)

```ts
// apps/web/db/schema.ts:208-236
export const outgoingPrs = pgTable("outgoing_prs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceFindingId: text("source_finding_id").notNull(),
  upstreamOwner: text("upstream_owner").notNull(),
  upstreamRepo: text("upstream_repo").notNull(),
  upstreamPrNumber: integer("upstream_pr_number").notNull(),
  branchOnFork: text("branch_on_fork").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  // current: open | merged | closed. New: + closed_absorbed
  status: text("status").notNull().default("open"),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
  mergeSha: text("merge_sha"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  // Fields being added in this sprint:
  // closureMethod: text  -- merged | absorbed_inline | declined | stale_timeout
  // closureSha: text     -- upstream commit SHA that applied the fix
  // closureDetectedAt: timestamptz
  // closureConfidence: real  -- 0.0..1.0
  // closureNotes: text   -- judge reasoning (optional, useful for audit)
});
```

## Lessons from predecessor (PR #5 + PR #8 manual detection)

The data captured in `docs/demos/upstream-fix-prs.md` came from manual detection during a daily operator watch. Specific patterns the autopilot should expect to replicate:

1. **Bundled fixes are common.** The closing commit for PR #5 (`bab1e4b`) bundled our fix with `add check: schema` work; the closing commit for PR #8 (`7329b8a`) bundled our `token0<token1` assertion with workflow-permission hardening. The LLM-judge must handle "X% of this commit is our fix + Y% is adjacent work" as a positive match, not a partial match — because the fix did land.

2. **Commit messages often reference the fix verbatim.** "assert token0<token1 ordering" in `7329b8a`'s message is identical to PR #8's title content. The judge can use commit message as a strong prior, but the diff is still the ground truth.

3. **Timing is informative.** Both absorbed-inline closures happened within minutes of the operator's burst of activity. If a closure transition happens during a quiet repo period (no recent commits at all), the judge should be more skeptical and lean toward `declined`.

4. **Operator-author identity might shift.** PR #5 was closed by us (`antfleet-ops`); PR #8 was closed by upstream owner (`Gordon Slater`). The detection logic must work for both closure paths.

5. **Honest-report gate is the right default.** From the autonomopoly v1 dogfood: "the honest-report gate fires when consensus is conservative; that's a feature." Same principle applies here — when the LLM-judge isn't sure, default to `declined`. False positive on absorption damages the brand more than a false negative.

## Lessons from the predecessor autopilot sprint (Virtuals dogfood brief)

`docs/autopilot/virtuals-dogfood-brief.md` is the structural template for this brief. Specific patterns worth carrying over:

1. **Phase 0 is for surfacing problems, not pushing past them.** If pre-flight fails, halt — don't try to fix and proceed in one motion.

2. **Identity check at the start of every write phase.** Easy to drift into Augustas11 if not vigilant; explicit `gh auth status` check before any push.

3. **Production DB writes require literal `i authorize` text.** Per memory: AskUserQuestion answers do NOT satisfy the classifier for prod writes. Plain text in chat is the only gate.

4. **Stop conditions are not failure modes** — they're surfacing points where operator judgment is needed. Frame them as checkpoints, not errors.

5. **Cost ceiling matters.** Track running spend during execution. Budget transparency makes the sprint reproducible.
