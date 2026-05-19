# Sprint 4 — Operator Portal + Receipt of the Week

> Invariants from `.omc/plans/antfleet-runbook.md §1` apply.

## Goal

Two surfaces that compound the work from Sprints 1-3:

1. **Operator portal** — let agent operators manually attribute a repo to a `factory_launches` row when auto-discovery failed. Closes the loop on the long tail.
2. **Receipt of the week** — homepage spot curating the most-interesting finding from the past 7 days. Gives ecosystem regulars a reason to check the site weekly.

## Re-check gate

- [ ] ≥3 `factory_launches` rows have hit `prelaunch_status='repo_not_found'` in production. If 0 after 4 weeks of factory watcher running, **defer indefinitely**.
- [ ] ≥10 published `agent_findings` rows in production.

## Preconditions

1. Sprint 3 shipped: `factory_launches`, `poll-factory.ts`, `run-prelaunch.ts` all in production.
2. Both re-check counts verified against production data.
3. `pnpm -F @antfleet/web typecheck && test && build` green.

## Deliverables

### 1. [CODEX] Operator claim schema

Spec:

```
Add a drizzle table `agent_claims` to apps/web/db/schema.ts:
  id text pk (nanoid),
  token_address text not null,
  repo_full_name text not null,
  claimed_at timestamp default now(),
  claimer_signature text not null,
  claimer_address text not null,
  status text not null default 'pending',
  rejection_reason text,
  verified_at timestamp.

Constraint: deployer_address from factory_launches must match
claimer_address for the claim to verify.

Generate migration. Output to .omc/codex-out/01-claims-schema/.
```

`status`: `pending | verified | rejected`

[CLAUDE-REVIEWS-CODEX] Run migration in dev. Verify FK semantics.

### 2. [CODEX] Operator claim API

Spec:

```
Implement POST apps/web/app/api/claim/route.ts.
Body: { tokenAddress, repoFullName, signature, message }
  - message format: "I am the deployer of <tokenAddress>. I attest
    that github.com/<repoFullName> is the agent's source repository.
    Nonce: <random-nonce>. Timestamp: <ISO>."

Validation:
  a. tokenAddress exists in factory_launches
  b. repoFullName matches github.com/<owner>/<repo> pattern; public repo
  c. signature recovers via viem.verifyMessage to
     factory_launches.deployer_address
  d. timestamp in message within last 10 minutes (replay prevention)
  e. Rate limit: 3 claims per token_address per 7d

Insert claim with status='pending'. On signature verification success:
status='verified', update factory_launches.repo_full_name +
repo_discovery_method='operator_submission' + repo_discovered_at.

Return 200 { claimId, agentUrl } on success. 400/401/429 otherwise.

Output to .omc/codex-out/02-claim-api/.
```

[CLAUDE-REVIEWS-CODEX] Carefully review signature verification — security-critical. Invoke security-reviewer agent on the diff before commit.

### 3. [CODEX] Operator claim page

Spec:

```
Implement apps/web/app/agents/[address]/claim/page.tsx.

If factory_launches row has repo_full_name set: show "Already attributed
to github.com/<repo>" with no form.

Otherwise: form with two fields (read-only token address, repo input),
plus "Sign with deployer wallet" button that:
  a. Generates message text shown to user
  b. Triggers wallet signature via window.ethereum
  c. POSTs to /api/claim
  d. On 200: redirect to /agents/<address>
  e. On error: inline message

Grep for existing wallet-connection pattern first. If none, use plain
window.ethereum — no new lib.

Output to .omc/codex-out/03-claim-page/.
```

[CLAUDE-REVIEWS-CODEX] UX flow check, error handling.

### 4. [CLAUDE] Surface unclaimed launches

Touches `/agents/[address]` rendering — Claude owns.

For `factory_launches` rows with `repo_full_name = null` AND `prelaunch_status = 'repo_not_found'`:

- Banner on `/agents/[address]`: "AntFleet couldn't find this agent's source repo. Are you the deployer? [Claim →]"
- Link to `/agents/[address]/claim`.

On `/agents` index: small "<N> agents awaiting attribution" link to a filtered view.

### 5. [CODEX] Receipt of the week schema

Spec:

```
Add a drizzle table `weekly_features` to apps/web/db/schema.ts:
  week_start date pk,
  finding_id text not null,
  curated_by text not null,
  rationale text,
  featured_at timestamp default now().

Generate migration. Output to .omc/codex-out/05-weekly-schema/.
```

`curated_by`: `'auto' | operator handle`

[CLAUDE-REVIEWS-CODEX] Migration.

### 6. [CLAUDE] Auto-curation logic

`apps/web/scripts/curate-weekly.ts`. Runs every Monday 00:00 UTC via cron.

Selection:

- Eligible: `agent_findings` published in the last 7d.
- Rank by: severity DESC (high > med > low > info), then `upstreamPrUrl IS NOT NULL`, then `upstreamMergedSha IS NOT NULL`, then `publishedAt DESC`.
- Pick top 1. Insert into `weekly_features` with `curated_by='auto'`.
- If no eligible findings: skip the week, do not insert.

Operator override: `scripts/feature-finding.ts <findingId> <rationale>` upserts a row for the current week with `curated_by=<operator>`.

### 7. [CODEX] Homepage feature surface

Spec:

```
Modify apps/web/app/page.tsx (homepage):
  - Read current week's row from weekly_features
  - Render featured-finding card above the fold: agent name + link,
    finding title, severity badge, summary, "see full receipt" CTA
  - If no current-week feature: show generic AntFleet intro

Output to .omc/codex-out/07-homepage/.
```

[CLAUDE-REVIEWS-CODEX] Visual hierarchy, mobile rendering.

### 8. [CLAUDE] Tweet drafts

Extend `post-drafts.ts`:

**a. Claim verified:**

```
TODO(voice)

operator-verified: <symbol> is github.com/<repo>
agent now has a source-of-truth code surface on antfleet
antfleet.dev/agents/<address>
```

**b. Weekly feature published:**

```
TODO(voice)

receipt of the week: <agent name>
<finding title> (<severity>)
<one-line summary>
antfleet.dev/agents/<address>
```

## Out of scope (sprint-specific)

- Operator accounts / persistent login.
- Editing or revoking claims.
- Multi-repo attribution (one repo per agent).
- Email digest of weekly features.

## Verification

- `pnpm -F @antfleet/web typecheck && test && build` green.
- `vercel ls --prod` READY after push.
- POST `/api/claim` with valid signature + matching deployer → 200, `factory_launches.repo_full_name` updated.
- POST `/api/claim` with mismatched signature → 401.
- Replay attack (old timestamp) → 401.
- `/agents/[address]/claim` page renders for unclaimed launch; banner shows on `/agents/[address]`.
- Manual `curate-weekly.ts` picks the right finding per ranking rules.
- Homepage shows current week's feature.
- Each tweet draft path emits a file.
- security-reviewer agent invoked on `/api/claim` diff before commit.

## Stop conditions

- All deliverables verified → done.
- Signature verification has any ambiguity in review → STOP, security-review again before shipping.
- Re-check gate fails (still <3 `repo_not_found` rows) → defer this sprint.
- Production deploy fails → stop, surface logs.

## On completion

Update `.omc/plans/antfleet-runbook.md`:

1. Mark Sprint 4 ✅ DONE with merged PR number; move ▶ NEXT to Sprint 5.
2. Append to §1 "Active surface":
   - Routes: `/agents/[address]/claim`, `/api/claim`
   - Tables: `agent_claims`, `weekly_features`
   - Libraries: `apps/web/scripts/curate-weekly.ts`, `apps/web/scripts/feature-finding.ts`
3. List under "Shipped:" in Sprint 4 entry.
4. Commit runbook update in the same PR.
