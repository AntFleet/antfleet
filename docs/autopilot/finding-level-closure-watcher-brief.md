# AntFleet Sprint 2 — Finding-Level Upstream Closure Watcher

**Brief type**: OMC autopilot execution brief
**Draft date**: 2026-05-27
**Status**: Drafted, pending operator review before firing
**Predecessor**: Sprint 1 (`docs/autopilot/absorbed-inline-detection-brief.md` + final commits `ec3d8aa`, `ce916b8`, `4a5322f`). All design decisions from the Sprint 2 design session are baked in below — no autopilot guessing.

---

## Goal

Detect whether a finding AntFleet flagged eventually got fixed on upstream — by any path, not just via an AntFleet-authored PR. This is the ground-truth signal the eval corpus (`eval_dual_candidates`) needs before step 3 sprint kicks in at `both_proposed >= 30`.

Sprint 1 covered outcomes when AntFleet opened a fix PR. Sprint 2 covers the broader case: AntFleet flagged a finding in a PR review (via the GitHub App's normal install flow or a benchmark replay); the finding may or may not have generated a separate AntFleet upstream PR; either way, **did the bug eventually get fixed on the canonical upstream repo?**

By end of sprint:

- `findingStatus` extended with upstream-closure columns
- `reviews` extended with explicit `canonical_upstream_owner` + `canonical_upstream_repo` for bench rows
- Adaptive poller in the cron tick: 6h default, 1h for findings <14d, 24h after 60d
- Hybrid matcher (line-range pre-filter → claude-haiku → opus escalation) ships with the same `realPollDeps` injection pattern as Sprint 1
- Targeted backfill applied to consensus findings on public repos from the last 60 days
- Receipts UI surfaces upstream-fix-landed badge (single "fix landed" label — granularity preserved in DB only)
- Eval harness has a documented join query against `findingStatus`
- Production deploy verified via `vercel ls --prod`

## Hard constraints

### Identity
- All writes to `antfleet/*` use `antfleet-ops`: `gh auth switch --user antfleet-ops` before any push or PR.
- Commit identity: `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>`. Never `Augustas11`. Never `ops@antfleet.dev` as committer email.

### Brand voice
- AntFleet voice: technical, evidence-first, no lowercase aesthetic, no emoji.
- New copy aligns with `docs/positioning.md` Layer 1-3 messaging.

### Production database writes
- Schema migrations are production DB writes. Per memory: prod DB writes need explicit `i authorize` from the operator in chat — AskUserQuestion answers do NOT satisfy the classifier. The autopilot **must halt at each migration apply step** and surface for plain-text authorization.
- Migration files go in `apps/web/db/migrations/` with naming `0027_*.sql` and `0028_*.sql` (verify current schema head is `0026` at pre-flight; if different, increment accordingly).
- Apply pattern (per memory): `pnpm exec tsx apps/web/db/apply-migration-XXXX.ts --apply`. Dry-run first without `--apply`.

### Driver constraint (CRITICAL — Sprint 1 footgun)
- `apps/web/db/index.ts` exports a Drizzle instance backed by `drizzle-orm/neon-http`. The neon-http driver **does not support multi-statement transactions** — calling `db.transaction()` throws "No transactions support in neon-http driver" at runtime. This bit Sprint 1 (`ec3d8aa` → fix in `ce916b8`).
- New code in this sprint must NOT use `db.transaction()`. Single-row updates use `db.update(...).returning()`. Multi-row updates that need atomicity use CTE / UPSERT at the SQL level, NOT a transaction wrapper.
- Sister bug `apps/web/app/api/claim/route.ts:137` is already tracked as a separate task chip — do not touch it in this sprint.

### Verify-before-claim
- After every push to `antfleet/antfleet` run `vercel ls --prod` — don't assume deploy succeeded.
- After backfill, verify reference outcomes (see "Reference data" below).
- Test the matchers against known cases before running backfill on the full corpus.

### Cost ceiling
- Sprint total: **$20** across all LLM judge calls (backfill + poller invocations during the sprint + tests).
- Per-finding-per-cycle target: <$0.10 via haiku-first hybrid matcher.
- Per-detection escalation to opus only when haiku returns low-confidence (<0.6) or when the finding has no anchor text.
- If burn rate suggests exceeding the ceiling, halt and surface to operator.

## Reference data (golden test cases)

The Sprint 1 absorbed-inline reference data still applies as a sanity check. Sprint 2 adds finding-level cases:

| Finding | Expected outcome |
|---|---|
| `feelocker-selector-2026-05-18` (agent_findings row) | Closed by `bab1e4b` on `Liquid-Protocol-Ops/agent-autonomopoly`. Hybrid matcher should detect this via the on-chain-monitor file path + selector keyword. |
| Aeon PR #200 bench findings (per memory) — 2 HIGH findings | Outcome unknown at brief time; this is a discovery case. Document detection results without expected closureSha. |
| Synthetic negative case (any finding the matcher returns "no candidate above threshold") | Should be classified as `not_closed_yet`, not `declined`. Sprint 2's enum semantics differ from Sprint 1's outgoing-PR closure: a finding without a matching upstream commit is "still open" (we keep watching) rather than "declined" (final). |

If the matcher claims `bab1e4b` for the feelocker selector finding with confidence ≥0.7, that's a correct positive identification. If it returns `not_closed_yet` for the synthetic negative, that's correct conservatism. Halt only if (a) reference positives miss or (b) the matcher returns false positives on the negative case.

## Phase 0 — Pre-flight verification (≤30 min)

Run in parallel:

1. `gh auth status` — confirm `antfleet-ops` is active.
2. Schema head check: query `SELECT MAX(id) FROM drizzle.__drizzle_migrations` — must equal `1779330000000` or similar (the migration applied as `0026_outgoing_prs_closure_method`). If different, recompute next migration numbers.
3. Confirm `findingStatus` schema in `apps/web/db/schema.ts:115` and inspect existing columns. The closure columns being added are deltas, not replacements.
4. Confirm `reviews` schema (`apps/web/db/schema.ts` near line 26) — note it has `is_benchmark`, `owner`, `repo`, but NO existing canonical-upstream columns.
5. Snapshot baseline counts:
   - Total `findingStatus` rows
   - Total `reviews` rows where `is_benchmark = true`
   - Total `agent_findings` rows
   - Total `eval_dual_candidates` rows (per Eval Phase 0)
6. Cost-tracking infra: confirm provider-cost logging is in place and queryable for haiku + opus calls.

**Stop condition**: any pre-flight check fails. Don't proceed with broken assumptions.

## Phase 1 — Schema migration (REQUIRES "i authorize")

Generate **two migrations** (separately, smaller is safer):

### Migration 0027 — `reviews_canonical_upstream`

Add nullable columns to `reviews`:
- `canonical_upstream_owner text` — populated only when `is_benchmark = true`
- `canonical_upstream_repo text` — same

### Migration 0028 — `finding_status_upstream_closure`

Extend `findingStatus`:
- `upstream_closure_sha text` (nullable) — upstream commit SHA that resolved the finding (could be on the canonical upstream, even if the finding originated from a bench review)
- `upstream_closure_method text` (nullable) — `merged | absorbed | squashed | not_closed_yet`. Default for never-checked is `null`; default for checked-no-match is `not_closed_yet`.
- `upstream_closure_detected_at timestamptz`
- `upstream_closure_confidence real`
- `upstream_closure_notes text` — LLM judge reasoning (useful for audit)
- `upstream_last_polled_at timestamptz` — drives the adaptive polling cadence
- `upstream_poll_attempts integer DEFAULT 0` — for backoff diagnostics

Update Drizzle schema in `apps/web/db/schema.ts` to match. Generate apply scripts mirroring `apply-migration-XXXX.ts` pattern.

**Halt + surface migration SQL to operator. Wait for `i authorize` before running each apply.**

After apply: re-query `drizzle.__drizzle_migrations` to confirm head is `0028`. Re-query target table columns to confirm new fields exist.

**Stop condition**: operator does not authorize migration apply. Brief halts; resume Phase 1 once authorized.

## Phase 2 — canonicalUpstream backfill for bench reviews

For every `reviews` row with `is_benchmark = true AND canonical_upstream_owner IS NULL`:

1. Query GitHub for the repo's fork parent: `gh api /repos/<owner>/<repo>` and read `parent.full_name`.
2. Split parent_full_name into owner/repo, write to `canonical_upstream_owner` + `canonical_upstream_repo`.
3. If the repo is not a fork (no `parent` field), look for a `BENCHMARK.md` at root and parse the canonical upstream URL from it.
4. If neither works, log a warning and leave the columns NULL. The poller will skip these.

Implementation: `apps/web/scripts/backfill-canonical-upstream.ts`. Dry-run first; operator reviews; `--apply` to commit.

**Stop condition**: more than 20% of bench reviews can't be matched to a canonical upstream. That suggests a metadata gap that needs investigation before the poller goes live.

## Phase 3 — Adaptive poller skeleton

Add a new function `runFindingUpstreamPoll()` in `apps/web/lib/finding-upstream-closure.ts` (new file). Wire into the cron tick at `apps/web/app/api/cron/sweep/route.ts` after the existing `runOutgoingPrsPoll()` call.

Polling logic:

```
SELECT findings WHERE:
  - upstream_closure_method IS NULL OR upstream_closure_method = 'not_closed_yet'
  - AND (severity is consensus — see "consensus filter" below)
  - AND ((finding < 14d AND last_polled > 1h ago)
         OR (finding 14-60d AND last_polled > 6h ago)
         OR (finding > 60d AND last_polled > 24h ago))
  - LIMIT by rate-limit budget (see below)
```

**Consensus filter**: a finding is "consensus" when it was flagged by both models (`agreed_count > 0` on the parent review). This needs a join from `findingStatus` → `reviews` → `eval_dual_candidates` (or whatever marks dual-confirmed findings). Inspect schema; if the consensus marker is per-finding rather than per-review, use that.

**Rate-limit budget**: the antfleet-ops PAT is shared with Sprint 1's `runOutgoingPrsPoll()`. Total REST budget is 5000 req/hr. Sprint 1 uses maybe 50-100 req/hr at current scale. Sprint 2 should cap itself at 3000 req/hr (leaving headroom for outgoing PRs + ad-hoc). Use GitHub's `compare` endpoint to fetch commit ranges in bulk per `(repo, since_sha)` rather than per-finding when possible.

**Force-push detection**: store `last_seen_main_sha` per polled repo (probably in `cron_cursors` or a new lightweight table). If main's current tip differs from `last_seen_main_sha` in a way that suggests rewrite (e.g., the previous tip is no longer reachable), trigger a full rescan of findings on that repo.

**Repo-level dedup cache**: cache LLM judge results per `(canonical_upstream_owner, canonical_upstream_repo, candidate_sha, file_path)` within a single sweep tick. Two findings on the same file closed by the same commit should pay one judge call. Cache is in-memory, scoped to the sweep tick.

Honest-report gate: when LLM matcher returns confidence < 0.7 OR throws/errors, mark the finding as `not_closed_yet` and bump `upstream_poll_attempts`. Never mark as `merged`/`absorbed`/`squashed` on uncertain results.

**Stop condition**: cron tick runtime exceeds 150s with finding-upstream-poll on top of existing work (180s maxDuration). If so, reduce per-tick `LIMIT` until budget fits.

## Phase 4 — Hybrid matcher

Add `detectFindingUpstreamClosure(finding, deps): Promise<ClosureResult>` to `apps/web/lib/finding-upstream-closure.ts`.

Algorithm:

1. **Line-range pre-filter** (cheap): query the upstream repo's recent commits (since `findingStatus.upstream_last_polled_at` or finding creation time) for commits that touched the finding's file at or near the flagged line range. If zero candidates, return `not_closed_yet`.

2. **Haiku judge** (medium): for each pre-filtered candidate, call `claude-haiku-4-5` (or latest haiku at sprint time) with:
   - Finding title, severity, summary, evidence (no diff)
   - Candidate commit message, candidate commit diff
   - Tool/structured output: `{ closes_finding: boolean, confidence: 0..1, reasoning: string }`
   - System prompt mirrors Sprint 1's prompt structure but adapted: the matcher must find evidence that the commit ADDRESSES THE FINDING'S SUBSTANTIVE ISSUE (not equivalent to a PR diff, since there's no PR diff to compare against).

3. **Opus escalation** (expensive): if haiku returns confidence between 0.5 and 0.75, OR if no haiku candidate clears 0.7, OR if the finding has no anchor text to compare against — escalate to `claude-opus-4-7` for a second opinion. Use the same prompt + tool schema; if opus disagrees, take opus's call.

4. **Best-match selection**: return the highest-confidence positive match above threshold 0.7. Otherwise return `not_closed_yet`.

Cost expectation: 80% of findings resolve at haiku (<$0.01 each). 20% escalate (~$0.05 each). Per-finding-per-cycle average: ~$0.02.

**Stop condition**: false-positive rate on the synthetic-negative test case exceeds 5%. Tighten threshold or rework prompt.

## Phase 5 — Honest-report tuning

Run the matcher against the reference data (Sprint 1's PR #5/#8 absorbed-inline cases + the `feelocker-selector-2026-05-18` finding). Tune confidence thresholds + prompt language until:

- All reference positives are detected at confidence ≥0.7
- Synthetic negatives return `not_closed_yet` with no false claims of closure
- Cost per detection stays within the $0.10/finding/cycle target

Commit prompt + threshold values together; document tuning rationale in commit message.

## Phase 6 — Targeted backfill (REQUIRES "i authorize")

`apps/web/scripts/backfill-finding-upstream-closure.ts` — runs the new detection logic on existing findings, scoped to:

- `severity IN ('high', 'med', 'low')` (i.e., consensus findings — adjust if the consensus filter is different)
- Parent review's `publicReceipt = true`
- Finding `published_at >= NOW() - INTERVAL '60 days'`

Dry-run first. Operator reviews the report (total processed, absorbed, declined, ambiguous, total cost). Operator authorizes; script runs with `--apply`. Stop if cost exceeds $15 of the $20 sprint budget.

**Stop condition**: more than 5% of backfilled findings end up with low-confidence positive matches that look semantically suspect when spot-checked. Halt and surface to operator before further `--apply`.

## Phase 7 — Eval harness join query

Add a documented query in `apps/web/lib/eval-corpus.ts` (or wherever the eval pipeline lives):

```sql
SELECT
  f.finding_id, f.title, f.severity,
  edc.both_proposed_label, edc.anthropic_label, edc.openai_label,
  fs.upstream_closure_method, fs.upstream_closure_sha,
  fs.upstream_closure_confidence
FROM agent_findings f
JOIN eval_dual_candidates edc ON edc.finding_id = f.finding_id
LEFT JOIN finding_status fs ON fs.finding_id = f.finding_id
WHERE edc.both_proposed = true
  AND f.published_at < NOW() - INTERVAL '14 days'
```

This is the ground-truth labeled dataset shape for eval step 3. Document in a comment block; no UI work needed in this sprint.

## Phase 8 — Tests + production verification

- Unit tests for `detectFindingUpstreamClosure()` covering:
  - Reference positive: `feelocker-selector` finding vs `bab1e4b`
  - Reference negative: a finding with no matching upstream commit
  - Force-push case: main's tip diverged; matcher should rescan
  - Dedup cache: two findings on same file/commit → one LLM call
- Integration test for the cron tick transition path (fixture row in test DB).
- E2E post-deploy:
  - `vercel ls --prod` — confirm latest deploy `Ready`.
  - Force-tick cron via CRON_SECRET; verify `findingUpstreamPoll` result in payload.
  - Spot-check antfleet.dev/receipts: at least one finding shows the new "fix landed" badge if any reference cases were backfilled.

## Stop conditions (any halt the run)

- Operator does not authorize a migration apply.
- Reference data validation fails (the feelocker finding doesn't match `bab1e4b`).
- Matcher false-positive rate >5% on synthetic negatives.
- Cron tick runtime exceeds 150s.
- Cost ceiling ($20) exceeded.
- UI rendering regresses existing receipts page.
- Vercel deploy fails after any push.

## Output checklist

- [ ] Migration `0027_reviews_canonical_upstream.sql` applied
- [ ] Migration `0028_finding_status_upstream_closure.sql` applied
- [ ] `reviews.canonical_upstream_*` backfilled for bench rows
- [ ] `finding-upstream-closure.ts` library shipped
- [ ] Cron tick integration: poll runs after `runOutgoingPrsPoll()`
- [ ] Hybrid matcher (haiku + opus escalation) tested against reference cases
- [ ] Targeted backfill executed (consensus + public + last 60d)
- [ ] Receipts page surfaces "fix landed" badge for `upstream_closure_method IN ('merged','absorbed','squashed')`
- [ ] Eval harness join query documented in `lib/eval-corpus.ts`
- [ ] Unit + integration tests passing
- [ ] Production deploy verified via `vercel ls --prod`
- [ ] Cost report logged

## Run metadata to capture

- Start UTC, end UTC
- Total LLM spend (haiku vs opus mix)
- Per-finding backfill timings
- Reference-data validation results (judge reasoning text)
- Production log anomalies
- Force-push detection events (if any fired during the sprint)

---

## Lessons inherited from Sprint 1

1. **Never `db.transaction()` in code paths reachable from the cron** — neon-http driver throws. Use `db.update(...).returning()` for single rows, CTE/UPSERT for multi-row atomic writes. Sprint 1 took two iterations to catch this.

2. **`override: true` on dotenv** — local scripts must use `dotenv.config({ path, override: true })` because Claude Code sessions pre-set `ANTHROPIC_API_KEY=""`. Without override, the LLM call silently fails.

3. **`MAX_CANDIDATE_COMMITS` should be 100, not 20** — in noisy repos (cron-emitting bots) a 20-deep window misses real human commits within a single day.

4. **LLM judge prompts should distinguish substantive vs cosmetic** — Sprint 1's first prompt rejected a real absorption because the commit didn't include the PR's cosmetic comment-text fix. Sprint 2's matcher must explicitly accept partial absorption when the functional substance is present.

5. **Honest-report gate is non-negotiable** — false positives on closure detection poison the eval corpus. When uncertain, classify conservatively (`not_closed_yet`, not `merged`).

6. **Reference data validation gates `--apply`** — bake reference cases (feelocker-selector → bab1e4b) into the backfill script's validation step. Halt + surface on FAIL; don't write bad data.

## Reference — design decisions baked in

(From Sprint 2 design session, 2026-05-27.)

| Decision | Value |
|---|---|
| Which findings monitored | Consensus only, all visibility |
| Polling cadence | 6h default, 1h <14d, 24h >60d |
| Matching algorithm | Line-range pre-filter → haiku → opus escalation |
| Closure data location | Extend `findingStatus`, no new table |
| Eval corpus integration | Join on `findingId` |
| Bench coverage | Monitor canonical upstream, not the bench fork |
| Repo-level dedup | Yes, per `(repo, sha, file)` per sweep tick |
| canonicalUpstream | New columns on `reviews`; backfill via fork-parent + BENCHMARK.md |
| Force-push detection | Yes, `last_seen_main_sha` per repo |
| Backfill scope | Targeted: consensus + public + last 60d |
| Receipts UI label | Single "fix landed" badge; granularity in DB only |
