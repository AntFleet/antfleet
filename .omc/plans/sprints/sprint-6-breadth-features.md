# Sprint 6 — Breadth Features (Leaderboard, Forks Tracker, Cross-Agent Catalog)

> Invariants from `.omc/plans/antfleet-runbook.md §1` apply.

## Goal

Ship the breadth-layer attention features that only become useful once the ecosystem has multiple reviewed agents:

1. **Leaderboard** — competitive surface, ranked by code-health metrics.
2. **Forks tracker** — divergence map between agents and their base template.
3. **Cross-agent findings catalog** — "X% of agents have Y bug" stat surface.

These were intentionally deferred from earlier sprints because pre-ecosystem versions render empty and screenshot poorly. Whole point is having enough rows for the comparison to feel weighty.

## Re-check gate

- [ ] N ≥ 5 distinct agents with at least one published finding each — verify: `SELECT COUNT(DISTINCT agent_token_address) FROM agent_findings WHERE agent_token_address NOT LIKE 'roast:%'` ≥ 5.
- [ ] ≥ 2 forks of `agent-autonomopoly` (or any base template) exist on chain — verify: ≥2 `factory_launches` rows whose repos share ≥50% file overlap with autonomopoly.

If either fails: **do not execute this sprint.** Empty-stage syndrome is worse than not shipping.

## Preconditions

1. Sprints 1-5 shipped.
2. Both re-check counts verified against production data.
3. `pnpm -F @antfleet/web typecheck && test && build` green.

## Deliverables

### 1. [CODEX] Leaderboard schema

Spec:

```
Add a drizzle view (or materialized view if pg supports it cleanly)
`agent_leaderboard` aggregating per-agent metrics:
  agent_token_address text pk,
  agent_name text,
  total_findings int,
  open_findings int,
  closed_findings int,
  high_severity_count int,
  closed_ratio numeric,
  days_since_last_review int,
  review_density_per_week numeric,
  last_finding_at timestamp.

Refresh: rebuild on every finding insert OR 1-hour cron. Document the
choice with a one-line comment.

Output to .omc/codex-out/01-leaderboard-schema/.
```

[CLAUDE-REVIEWS-CODEX] Verify aggregations against production data. Spot-check 2-3 agents manually.

### 2. [CODEX] Leaderboard route

Spec:

```
Implement apps/web/app/agents/leaderboard/page.tsx.

Default sort: closed_ratio DESC, then review_density_per_week DESC.
Sortable columns via ?sort=<column>&dir=<asc|desc>.

Columns:
  agent (name + link to /agents/[address])
  total findings
  closed ratio (percentage)
  high-severity count
  days since last review
  review density (findings/week, last 4w)

Pagination: 25 per page.

Empty state: if N<5 agents have findings, show warning banner
"Leaderboard requires ≥5 agents — currently N=<n>". Never let the page
ship broken.

Output to .omc/codex-out/02-leaderboard-page/.
```

[CLAUDE-REVIEWS-CODEX] Visual hierarchy, sort UX, mobile rendering.

### 3. [CLAUDE] Forks detection logic

`apps/web/lib/fork-detection.ts`. Touches repo content analysis — Claude owns.

Approach:
- For each `factory_launches` row with `repo_full_name` set, fetch file tree via `gh api repos/<owner>/<repo>/git/trees/HEAD?recursive=1`.
- Compute file-path Jaccard against autonomopoly (canonical base).
- If overlap >50%: classify as fork.
- Per fork, compute:
  - Files added (in fork, not in base).
  - Files removed (in base, not in fork).
  - Files modified (compare content hashes of shared paths).
  - Identity Jaccard distance from autonomopoly's `identity.autonomopoly.json`.

Store in new table `agent_forks`:
```
  agent_token_address text pk,
  base_agent_token_address text not null,
  file_overlap_ratio numeric,
  files_added int,
  files_removed int,
  files_modified int,
  identity_drift_from_base numeric,
  computed_at timestamp.
```

Refresh: rebuild on new `repo_discovered_at` events; otherwise weekly cron.

### 4. [CODEX] Forks tracker page

Spec:

```
Implement apps/web/app/agents/forks/page.tsx.

For each non-base agent (base_agent_token_address IS NOT NULL):
  - Row: agent name + link, base agent name + link, overlap %, files
    added/removed/modified, identity drift score
  - Expandable sub-row: top 5 added files, top 5 modified files

Render a divergence visualization. Reuse the drift-monitor's chart if
present; otherwise plain SVG bars.

Output to .omc/codex-out/04-forks-page/.
```

[CLAUDE-REVIEWS-CODEX] Visualization clarity. Verify computations against actual repo state for 2-3 forks.

### 5. [CLAUDE] Cross-agent findings aggregation

`apps/web/lib/finding-patterns.ts`. Pattern detection — Claude owns.

Approach:
- Group `agent_findings` by normalized `title` (lowercase, stripped of agent-specific tokens like names, addresses, paths).
- For each pattern: count distinct agents affected, list them.

Store in `finding_patterns` table:
```
  pattern_id text pk,
  normalized_title text,
  example_finding_id text,
  agent_count int,
  affected_agent_addresses text[],
  first_observed_at timestamp,
  last_observed_at timestamp.
```

Refresh: weekly cron OR on-demand when a new finding is published.

### 6. [CODEX] Findings catalog page

Spec:

```
Implement apps/web/app/findings/patterns/page.tsx.

Render finding_patterns sorted by agent_count DESC. Each pattern shows:
  - Normalized title
  - "<N> of <total> agents affected" (percentage as tweetable bold text)
  - List of affected agents (linked)
  - Link to the example finding

Output to .omc/codex-out/06-patterns-page/.
```

[CLAUDE-REVIEWS-CODEX] Verify percentages are mathematically honest (denominator = agents with ANY finding, not all agents).

### 7. [CLAUDE] Tweet drafts

Three new draft paths:

**a. New top-of-leaderboard agent:**
```
TODO(voice)

new #1 on antfleet leaderboard: <agent name>
closed-finding ratio: <X>%
review density: <Y>/week
antfleet.dev/agents/leaderboard
```

**b. New fork detected:**
```
TODO(voice)

new fork of <base>: <new agent>
<X>% file overlap · identity drift <Y>
divergence: <files added> added / <files modified> modified
antfleet.dev/agents/forks
```

**c. Finding pattern crosses threshold (≥3 agents):**
```
TODO(voice)

<X> of <Y> reviewed agents share this finding:
"<normalized title>"
antfleet.dev/findings/patterns
```

Highest-payoff content in this entire runbook. Each fires automatically when its data condition is met.

## Out of scope (sprint-specific)

- Personalized agent dashboards.
- Holder-facing portfolio views.
- Cross-chain leaderboards.
- LLM-based deep pattern clustering (rule-based is enough for v1).
- Agent-vs-agent direct comparison views.

## Verification

- `pnpm -F @antfleet/web typecheck && test && build` green.
- `vercel ls --prod` READY after push.
- `/agents/leaderboard` renders ≥5 rows with correct metrics.
- `/agents/forks` renders ≥2 forks with sensible divergence numbers.
- `/findings/patterns` shows at least 1 pattern shared by ≥2 agents.
- Sortable columns work on leaderboard.
- Empty-state warning shows when filtered.
- Tweet draft paths emit files when triggered manually.
- Every new route in a real browser.

## Stop conditions

- All deliverables verified → done.
- Re-check gate fails at start → stop, do not execute.
- Codex spec-non-compliance >2 retries → Claude takes over.
- Fork detection produces obviously wrong classifications → tighten overlap threshold.
- Finding pattern normalization too aggressive (collapses unrelated bugs) → stop, refine.
- Production deploy fails → stop, surface logs.

## On completion

Update `.omc/plans/antfleet-runbook.md`:
1. Mark Sprint 6 ✅ DONE with merged PR.
2. Append to §1 "Active surface":
   - Routes: `/agents/leaderboard`, `/agents/forks`, `/findings/patterns`
   - Tables/views: `agent_leaderboard`, `agent_forks`, `finding_patterns`
   - Libraries: `apps/web/lib/fork-detection.ts`, `apps/web/lib/finding-patterns.ts`
3. List under "Shipped:" in Sprint 6 entry.
4. Add "Sprint 7+ TBD" placeholder — re-strategize before drafting Sprint 7.
5. Commit runbook update in the same PR.
