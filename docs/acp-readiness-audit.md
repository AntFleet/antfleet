# ACP readiness audit

Date: 2026-06-10

Worktree: `/Users/augstar/projects/antfleet-acp-readiness-audit`
Branch: `codex/acp-readiness-audit`
Base: `origin/main` at `269d7044d8831d5ea204595f7220b0b74343723a`

## Audited PRs and commits

- PR #82, `[codex] Run ACP jobs through AntFleet worker`, merged 2026-06-10T06:24:27Z, merge commit `269d7044d8831d5ea204595f7220b0b74343723a`.
- PR #81, `[codex] Define ACP receipt-backed review public contract`, merged 2026-06-10T03:14:03Z, merge commit `3c8e2d2d1dc9b19f916a4a8d2735ad138f72aee6`.

PR #82 commits inspected:

- `5b298e9` Run ACP jobs through AntFleet worker
- `21b7e2a` Accept ACP review work through receipt-backed provider flow
- `2860d0c` Prepare ACP reviewer registration safely
- `a3f9e27` Gate ACP intake abuse before budget
- `20e855c` Make ACP listing compatible with Virtuals dashboard
- `22bcc3b` Keep ACP offering name within dashboard limit
- `fea8127` Use sharper ACP offering name
- `d6dbbe8` Format ACP readiness files for CI

PR #81 commits inspected:

- `3ac6447` Define ACP receipt-backed review public contract
- `641d343` Format ACP public contract files

## Files inspected

- `apps/web/lib/acp/intake-adapter.ts`
- `apps/web/lib/acp/intake-adapter.test.ts`
- `apps/web/lib/acp/event-inbox.ts`
- `apps/web/lib/acp/event-inbox.test.ts`
- `apps/web/lib/acp/rate-limit.ts`
- `apps/web/lib/acp/rate-limit.test.ts`
- `apps/web/lib/acp/review-contract.ts`
- `apps/web/lib/acp/review-contract.test.ts`
- `apps/web/lib/acp/provider-cli.ts`
- `apps/web/lib/review-job-queries.ts`
- `apps/web/lib/review-job-queries.acp.test.ts`
- `apps/web/lib/review-job-worker.ts`
- `apps/web/lib/review-job-worker.acp.test.ts`
- `apps/web/scripts/acp-provider-worker.ts`
- `apps/web/scripts/acp-provider-worker.test.ts`
- `apps/web/app/api/cron/review-jobs/route.ts`
- `apps/web/app/api/cron/review-jobs/route.test.ts`
- `apps/web/app/api/v1/acp/review-jobs/[jobId]/route.ts`
- `apps/web/db/migrations/0036_review_jobs_acp.sql`
- `apps/web/db/migrations/0036.test.ts`
- `apps/web/db/schema.ts`
- `apps/web/public/schemas/acp/*.json`
- `apps/web/data/acp/*.json`
- `docs/acp-provider-runbook.md`
- `specs/SPEC-ACP-001-receipt-backed-code-review.md`
- `apps/web/app/acp/page.tsx`

## Audit checklist

- ACP intake accepts only schema-valid PR requests with exactly one target selector.
- ACP intake resolves and persists a concrete PR head SHA before budget setup.
- Abuse checks run before a paid ACP row is created for fresh jobs.
- Same `acp_job_id` replays are idempotent; different ACP job IDs for the same wallet/repo/PR/SHA are rejected before budget setup.
- ACP wallet rate limits and repo cooldowns are scoped to ACP rows, not x402/channel rows.
- Trading-code targets require `acknowledge_not_financial_advice=true`.
- Budget setup is claimed before invoking the ACP CLI and records `set_failed` or `set_reconcile` on failure boundaries.
- Funded jobs queue only after local budget state is `set`.
- Durable inbox claims events before side effects, retries failed/expired-processing rows, and dead-letters after capped attempts.
- Provider worker recovery owns ACP queued/running recovery; web cron skips ACP unless `ACP_WEB_CRON_ENABLED` is set.
- ACP submit transitions claim `submitting` before calling the CLI and do not send duplicate terminal deliverables after a prior submit is in progress or submitted.
- Public ACP status projection omits raw request payload, raw submit response, raw provider output, and model internals.
- Post-submit lifecycle, evaluator/dispute handling, settlement, CLI registration, and live smoke status are documented as launch constraints.

## Findings by severity

### High - fixed - ACP worker could review a moved PR head after intake

PR #82 persisted the PR head SHA during intake, keyed duplicate policy on that SHA, and ran trading-code eligibility against that snapshot. The worker later re-read the PR and used the then-current head SHA for review. If a buyer pushed new commits between budget setup and funded execution, AntFleet could review a different SHA than the one accepted, bypassing the duplicate target key and any intake-time trading-code heuristic result.

Fix: `resolveAcpReviewTarget()` now rejects PR-head drift when `review_jobs.sha` is already set. The funded job returns a schema-valid ACP error with code `sha_not_in_open_pr` instead of reviewing unintended code.

Regression: `apps/web/lib/review-job-worker.acp.test.ts` now asserts a moved PR head fails before `enqueueReview()` or `getPublicChangedFiles()` can run.

### Medium - fixed - funded-event replay could dead-letter while a legitimate review was still running

`runFundedAcpReviewJob()` treated an already-running review job as retryable by invoking `processReviewJob()`, receiving `status_is_running`, and throwing. That is unsafe for duplicate funded events with different event IDs: the inbox retry schedule can reach dead-letter before the 10-minute worker timeout, even though the funded state has already been consumed and the original worker owns terminal delivery.

Fix: funded events for ACP jobs already in `running`, `complete`, or `failed` are now idempotent no-ops. The original running worker remains responsible for success/error submit.

Regression: `apps/web/lib/acp/intake-adapter.test.ts` now asserts running funded replays return `worker: null` and do not call `processReviewJob()`.

### Medium - fixed - heuristic trading-code reviews could omit the required disclaimer

The spec requires the disclaimer when reviewing trading-agent or financial workflow code. Intake can require `acknowledge_not_financial_advice=true` based on repo topics, descriptions, or changed file paths even when the buyer did not request `focus: trading-risk`. The deliverable path only checked explicit `trading-risk` focus, so heuristic trading-code cases could omit the disclaimer after requiring the acknowledgment.

Fix: ACP deliverables now include the disclaimer whenever the stored request has `options.acknowledge_not_financial_advice=true`, or when focus explicitly includes `trading-risk`.

Regression: `apps/web/lib/review-job-worker.acp.test.ts` now asserts acknowledged trading-code boundary requests include the disclaimer in the submitted deliverable.

### Medium - fixed - ACP failure payloads could reuse channel-refund wording

Security review of PR #83 found that the ACP worker reused the channel payment helper `safeFailureMessage()`. That helper says provider, timeout, and internal failures refunded the user's channel, but ACP jobs use escrow/refundable/operator-review settlement semantics. A buyer, provider, or evaluator could receive an ACP error payload whose `settlement` field said `escrow_refundable` while the public message claimed a channel refund that did not happen.

Fix: ACP failures now use ACP-specific public messages that avoid channel/refund claims and align with the ACP error settlement field.

Regression: `apps/web/lib/review-job-worker.acp.test.ts` now asserts provider-error ACP payloads do not contain `channel` or `refunded` and preserve `settlement: "escrow_refundable"`.

## No additional code findings

- Intake parsing and validation are strict through Zod and reject malformed request shape, dual `target.pr`/`target.sha`, unsupported modes, invalid wallets, and trading focus without acknowledgment.
- Budget state transitions are guarded around `pending`/`set_failed` claim states and preserve `set_reconcile` when external budget setup succeeded but local persistence failed.
- Duplicate target policy is enforced before budget setup for different ACP job IDs and preserves same-job idempotency.
- ACP wallet/repo abuse checks are ACP-specific and ignore x402/channel rows.
- ACP submit guards claim `submitting` before external submit and preserve ambiguous success submission state without sending a second error payload.
- Public status projection returns status, submit status, safe failure fields, and summarized result/error fields only.
- Web cron isolation is implemented and tested; ACP recovery defaults to the provider worker.

## Accepted risks

- `acp_provider_events.payload` stores raw provider events in the private database for replay/debugging. Public projections do not expose this payload.
- `acp_submit_response` may contain raw ACP CLI response/error context in the private database for operator reconciliation. Public projections do not expose it.
- The public status URL is unauthenticated by design because the deliverable includes it for buyer/evaluator polling. It must remain redacted and no-store.
- `set_reconcile`, `submit_failed`, and `submitting` recovery are operator-runbook driven in v0.
- ACP event shape compatibility is based on local CLI `1.0.12` and README/runbook assumptions, not a completed live/testnet smoke.

## Remaining go-live blockers

- Testnet ACP CLI auth is not configured for this checkout, so testnet event intake, budget set, funding, deliverable submit, and error submit smoke remain unrun.
- Mainnet smoke remains an operator-money action; the offering should stay hidden until operator-approved smoke passes.
- Buyer accept/reject, evaluator/dispute events, settlement finality, and marketplace terminal state remain docs-first until real ACP event payloads are observed.
- Process-manager deployment must run one durable listener plus one non-overlapping provider worker and alert on dead letters, budget reconciliation, submit failures, and stuck ACP jobs.
- `ANTFLEET_PUBLIC_BASE_URL`, `DATABASE_URL`, model provider keys, `GITHUB_PUBLIC_TOKEN`, ACP CLI credentials, and `ACP_CONFIG_DIR` must be set in the exact runtime user/config directory that runs the listener and worker.

## Fixes made

- Added funded-event replay idempotency for already-running ACP review jobs.
- Added PR-head drift rejection before ACP worker enqueue/review.
- Added trading disclaimer emission for requests that stored the no-financial-advice acknowledgment.
- Added ACP-specific public failure messages for ACP error payloads.
- Added regression coverage for all four fixes.

## Verification

Initial targeted regressions failed before fixes:

- `pnpm --dir apps/web test lib/acp/intake-adapter.test.ts lib/review-job-worker.acp.test.ts`
  - failed on missing disclaimer and PR-head drift behavior;
  - also exposed that direct web tests require the root `@antfleet/cli` package to be built first in a fresh worktree.

Passing checks after fixes:

- `pnpm install --frozen-lockfile`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm build`
- `pnpm --dir apps/web typecheck`
- `pnpm --dir apps/web test lib/review-job-worker.acp.test.ts`
- `pnpm --dir apps/web test lib/acp/intake-adapter.test.ts`
- `pnpm --dir apps/web test lib/acp/intake-adapter.test.ts lib/acp/rate-limit.test.ts lib/review-job-queries.acp.test.ts lib/acp/review-contract.test.ts lib/review-job-worker.acp.test.ts scripts/acp-provider-worker.test.ts app/api/cron/review-jobs/route.test.ts` (57 tests)
- `git diff --check`
- `jq empty apps/web/public/schemas/acp/review-request-v0.json apps/web/public/schemas/acp/review-deliverable-v0.json apps/web/public/schemas/acp/review-error-v0.json apps/web/data/acp/review-request.valid-pr.json apps/web/data/acp/review-deliverable.no-findings.json apps/web/data/acp/review-deliverable.findings.json apps/web/data/acp/review-error.provider-degraded.json`
- `gh pr view 82 --json title,url,mergedAt,mergeCommit,body`
- `gh pr view 81 --json title,url,mergedAt,mergeCommit,body`

Build gap:

- `pnpm --dir apps/web build` compiled and passed TypeScript, then failed during Next page-data collection because `DATABASE_URL` is not set in this local audit worktree. The failure was `DATABASE_URL is required; set it via Vercel Marketplace (Neon) or .env.local` while collecting `/disagreements/[id]/opengraph-image`. This matches PR #82's local-build caveat that full web build needs live database access.
