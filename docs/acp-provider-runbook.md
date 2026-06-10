# ACP Provider Runbook

Status: PR #82 readiness notes for registering the AntFleet ACP Reviewer on the
Virtuals ACP CLI.

Sources checked on 2026-06-10:

- local `acp` CLI `1.0.12`
- upstream `Virtual-Protocol/acp-cli` README command reference

## Runtime Ownership

PR #82 intentionally runs the v0 ACP adapter from `AntFleet/antfleet`
(`apps/web/scripts/acp-provider-worker.ts`) because the existing receipt,
review job, and public status machinery already live here. This supersedes the
original spec direction that all runtime code must start in
`AntFleet/antfleet-core`.

Keep this as a narrow v0 pivot:

- `AntFleet/antfleet` owns ACP intake, inbox durability, review job execution,
  ACP submit state, and public status projection for this launch.
- `AntFleet/antfleet-core` remains the intended future extraction target if the
  provider runtime grows beyond this adapter.
- `Virtual-Protocol/acp-cli-demos` remains the right place for upstream demo or
  submission examples if Virtuals asks for them.

## Environment

Required for the provider worker:

- `DATABASE_URL`: database with migration `0036_review_jobs_acp.sql` applied.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`: existing two-reviewer pipeline keys.
- `ACP_CONFIG_DIR`: optional, but recommended for deploy isolation. Example:
  `/var/lib/antfleet-acp/.config/acp`.
- `ACP_EVENTS_FILE`: event spool file read by the worker. Default:
  `.acp/events.jsonl`.
- `ACP_REVIEW_PRICE_USDC`: ACP offering and budget price. Default: `1.00`.
- `ANTFLEET_PUBLIC_BASE_URL`: public base URL used in ACP status and receipt
  links. Production: `https://www.antfleet.dev`.

Recommended:

- `GITHUB_PUBLIC_TOKEN`: raises GitHub public API rate limits for target
  resolution and changed-file lookup.
- `X402_MAX_TIMEOUT_SECONDS`: reused wall-clock timeout for review execution.
  Default remains the x402 timeout constant.
- `IS_TESTNET=true`: only for testnet CLI state and testnet smoke runs.

The ACP CLI keeps mainnet and testnet config separately. Authenticate the exact
runtime user and config dir that will run the listener/worker.

## CLI Credentials

Agent-friendly auth flow:

```sh
export ACP_CONFIG_DIR=/var/lib/antfleet-acp/.config/acp
acp configure start --json
# open the returned URL as the AntFleet operator
acp configure complete --request-id "$REQUEST_ID" --wait --json
acp agent use --agent-id "$ANTFLEET_AGENT_ID"
acp agent add-signer --agent-id "$ANTFLEET_AGENT_ID" --policy restricted
acp agent whoami --json
```

Current local status on 2026-06-10:

- mainnet ACP CLI auth exists for agent `AntFleet`
  (`0x9add64c65ed3ba1b06a068c18332ec95cf6a60d4`);
- no offering is registered on that agent yet;
- `IS_TESTNET=true acp agent whoami --json` is not authenticated, so testnet
  smoke was not run.

## Offering Registration

Create the listing hidden first, inspect it, then make it visible only after a
testnet or operator-approved mainnet smoke.

```sh
REQ_SCHEMA="$(jq -c . apps/web/public/schemas/acp/review-request-v0.json)"
DELIVERABLE_SCHEMA="$(jq -c . apps/web/public/schemas/acp/review-deliverable-v0.json)"

acp offering create \
  --name "Receipt-backed code review for agent repos" \
  --description "Two-model consensus review for public GitHub PRs, with structured findings and SHA-pinned receipt URLs." \
  --price-type fixed \
  --price-value "${ACP_REVIEW_PRICE_USDC:-1.00}" \
  --sla-minutes 30 \
  --requirements "$REQ_SCHEMA" \
  --deliverable "$DELIVERABLE_SCHEMA" \
  --no-required-funds \
  --hidden

acp offering list --json
```

Visible listing command after smoke:

```sh
acp offering update \
  --offering-id "$ACP_OFFERING_ID" \
  --no-hidden
```

## Listing Copy

Title: Receipt-backed code review for agent repos

Short description: Two-model consensus review for public GitHub PRs, with
structured findings and SHA-pinned receipt URLs.

Long description:

AntFleet reviews agent repositories the way agents need: machine-readable,
escrow-friendly, and auditable. Submit a public GitHub PR. AntFleet runs two
independent frontier model reviews, returns only findings both models agree on,
and provides a review receipt URL. When findings are fixed, AntFleet pins
closure receipts to the resolving SHA. Best for ACP handlers, agent wallets,
workflow scripts, and trading-agent infrastructure. Not financial advice and
not a guarantee that code is secure or bug-free.

Tags: `code-review`, `security`, `receipts`, `github`, `acp`,
`agent-trust`, `auditability`.

## Process Manager

Run two processes:

1. One long-lived ACP listener appending NDJSON events.
2. One recurring worker that drains, retries inbox rows, recovers orphaned jobs,
   and terminalizes stuck ACP jobs.

Example commands:

```sh
mkdir -p .acp
acp events listen --output "${ACP_EVENTS_FILE:-.acp/events.jsonl}"

flock -n .acp/provider-worker.lock \
  pnpm --dir apps/web exec tsx scripts/acp-provider-worker.ts \
  --file "${ACP_EVENTS_FILE:-.acp/events.jsonl}" \
  --limit 20 \
  --retry-limit 20
```

Deploy recommendation:

- systemd service for `acp events listen`;
- systemd timer every 30-60 seconds for the `flock`-guarded worker command;
- restart listener on failure with backoff;
- alert if the worker exits non-zero twice consecutively or if dead letters are
  non-zero for more than one interval.

PM2 or a container supervisor is fine if it gives the same properties:
single listener, non-overlapping worker runs, logs, restart backoff, and
environment isolation.

## Recovery Commands

Retry normal failed/pending inbox rows:

```sh
pnpm --dir apps/web exec tsx scripts/acp-provider-worker.ts \
  --file "${ACP_EVENTS_FILE:-.acp/events.jsonl}" \
  --limit 0 \
  --retry-limit 50
```

If the listener is healthy but the worker is behind, run the worker against the
existing spool. Do not run `acp events drain` by hand unless you are capturing
its stdout into a file; drain removes events from the spool.

```sh
pnpm --dir apps/web exec tsx scripts/acp-provider-worker.ts --file "${ACP_EVENTS_FILE:-.acp/events.jsonl}"
```

Inspect an ACP job:

```sh
acp job history --job-id "$ACP_JOB_ID" --chain-id "${ACP_CHAIN_ID:-8453}" --json
psql "$DATABASE_URL" -c "select job_id, status, acp_budget_status, acp_submit_status, failure_mode, failure_message from review_jobs where payment_rail = 'acp' and acp_job_id = '$ACP_JOB_ID';"
```

Manually rerun a stuck local worker job only after confirming ACP has not
already received a terminal deliverable:

```sh
pnpm --dir apps/web exec tsx scripts/acp-provider-worker.ts --limit 0 --retry-limit 0
```

## Alert Queries

Dead letters:

```sql
select event_key, acp_job_id, event_type, attempts, failure_message, next_retry_at
from acp_provider_events
where status = 'dead_lettered'
order by created_at asc;
```

Budget reconciliation required:

```sql
select job_id, acp_job_id, status, acp_budget_status, acp_budget_attempts,
       acp_budget_updated_at, acp_budget_response
from review_jobs
where payment_rail = 'acp'
  and acp_budget_status in ('set_failed', 'set_reconcile', 'setting')
order by acp_budget_updated_at asc nulls first;
```

Submit failures:

```sql
select job_id, acp_job_id, status, acp_submit_status,
       acp_submitted_at, failure_mode, failure_message, acp_submit_response
from review_jobs
where payment_rail = 'acp'
  and acp_submit_status = 'submit_failed'
order by acp_submitted_at asc nulls first;
```

Stuck jobs:

```sql
select job_id, acp_job_id, status, acp_budget_status, acp_submit_status,
       created_at, started_at, completed_at
from review_jobs
where payment_rail = 'acp'
  and (
    (status = 'billing_pending' and created_at < now() - interval '10 minutes')
    or (status = 'queued' and created_at < now() - interval '2 minutes')
    or (status = 'running' and started_at < now() - interval '10 minutes')
    or (acp_submit_status = 'submitting' and acp_submitted_at < now() - interval '5 minutes')
  )
order by created_at asc;
```

Duplicate target policy evidence:

```sql
select acp_target_key, count(*) as jobs, array_agg(acp_job_id order by created_at) as acp_jobs
from review_jobs
where payment_rail = 'acp' and acp_target_key is not null
group by acp_target_key
having count(*) > 1;
```

This should return zero rows because PR #82 links duplicate `(wallet, repo, PR,
SHA)` ACP requests to the existing local row instead of creating a second review.

## Demo And Smoke

Testnet setup:

```sh
export IS_TESTNET=true
export ACP_CONFIG_DIR=/var/lib/antfleet-acp-testnet/.config/acp
acp configure start --json
acp configure complete --request-id "$REQUEST_ID" --wait --json
acp agent create --name "AntFleet Testnet" --description "ACP review smoke runner"
acp agent add-signer --policy restricted
```

Register the hidden offering using the registration command above, then use a
separate buyer agent/config dir for the client sequence:

```sh
export PROVIDER_WALLET=0xProviderAddress
export ACP_CHAIN_ID=84532
export REQUIREMENTS='{"mode":"pr","target":{"repo":"AntFleet/acp-fixture","pr":1},"options":{"public_receipt":true,"focus":["security","api-contract"],"max_findings":10}}'

acp client create-job \
  --provider "$PROVIDER_WALLET" \
  --offering-name "Receipt-backed code review for agent repos" \
  --requirements "$REQUIREMENTS" \
  --chain-id "$ACP_CHAIN_ID" \
  --json

export ACP_JOB_ID=...
acp provider set-budget --job-id "$ACP_JOB_ID" --amount "${ACP_REVIEW_PRICE_USDC:-1.00}" --chain-id "$ACP_CHAIN_ID" --json
acp client fund --job-id "$ACP_JOB_ID" --amount "${ACP_REVIEW_PRICE_USDC:-1.00}" --chain-id "$ACP_CHAIN_ID" --json
```

Provider event/worker path:

```sh
acp events listen --output .acp/testnet-events.jsonl
pnpm --dir apps/web exec tsx scripts/acp-provider-worker.ts --file .acp/testnet-events.jsonl --limit 20 --retry-limit 20
acp job history --job-id "$ACP_JOB_ID" --chain-id "$ACP_CHAIN_ID" --json
```

Manual deliverable submit check if isolating the CLI from the worker:

```sh
acp provider submit \
  --job-id "$ACP_JOB_ID" \
  --deliverable "$(jq -c . apps/web/data/acp/review-deliverable.no-findings.json)" \
  --chain-id "$ACP_CHAIN_ID" \
  --json
```

Manual error submit check:

```sh
acp provider submit \
  --job-id "$ACP_JOB_ID" \
  --deliverable "$(jq -c . apps/web/data/acp/review-error.provider-degraded.json)" \
  --chain-id "$ACP_CHAIN_ID" \
  --json
```

Buyer accept/reject lifecycle:

```sh
acp client complete --job-id "$ACP_JOB_ID" --chain-id "$ACP_CHAIN_ID" --reason "Schema and receipt URL verified" --json
acp client reject --job-id "$ACP_JOB_ID" --chain-id "$ACP_CHAIN_ID" --reason "Fixture rejection path smoke" --json
```

Do not run both accept and reject on the same live job. Use separate jobs for
success and dispute smoke.

## Post-submit Lifecycle Model

PR #82 currently records provider submission state through
`acp_submit_status` and projects AntFleet status publicly. It does not yet
persist buyer accept/reject, evaluator/dispute result, or final settlement.

Docs-first model for registration:

- after `provider submit`, ACP owns client accept/reject and escrow movement;
- `client complete` should be treated as final accepted/settled;
- `client reject` should create an operator dispute task tied to the immutable
  submitted deliverable;
- evaluator result should be stored only after the exact event shape is observed
  in testnet/mainnet events;
- add DB columns only after seeing real ACP event payloads for acceptance,
  rejection, evaluator decision, and settlement.

Candidate future columns:

- `acp_marketplace_status`
- `acp_client_decision`
- `acp_evaluator_result`
- `acp_settlement_status`
- `acp_lifecycle_response`
- `acp_lifecycle_updated_at`

## Live Verification Status

Not run in this slice:

- live/testnet event intake;
- testnet budget set;
- funded event;
- worker deliverable submit;
- worker error submit.

Reason: local mainnet credentials exist, but there is no registered offering and
no authenticated testnet agent. Creating/funding jobs on mainnet is an
operator-money action and should happen only after an explicit smoke window.
