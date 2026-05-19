# Standalone prompt — fix AntFleet webhook review-queuing failure

> **How to use this:** open a fresh Claude Code session in `/Users/augstar/projects/antfleet/` and paste the block below as your first message. The block is self-contained — the new session does not need to know anything about the Venice spike work or this conversation.

---

```
/omc-plan

# AntFleet GitHub-App webhook: add durable review queuing

## Problem (verified on 2026-05-18)

The production AntFleet GitHub App stalled at 10/30 reviews during a burst on
`antfleet/aeon-bench` (30 PRs opened in 4.5 minutes, only 10 produced
`antfleet[bot]` review comments). Root cause: the webhook handler runs
`reviewPR()` inline with no retry/queue path, so when the first ~10 concurrent
invocations exhausted LLM provider rate limits or Vercel function concurrency,
the remaining 20 review attempts errored and were silently lost.

Evidence:
- `apps/web/app/api/github/webhook/route.ts:34` already has a TODO: "split
  review into a separately-dispatched worker (e.g. QStash / Inngest)"
- `apps/web/lib/review-pipeline.ts` has zero retry/backoff logic
  (`grep -n "429\|rate\|retry\|backoff" review-pipeline.ts` returns nothing)
- `apps/web/vercel.json` cron `0 6 * * *` is for finding sweep, NOT for
  initial review — so a stalled webhook is not auto-recovered

Manual recovery (push empty commit to each stalled PR) is operationally
painful and doesn't scale.

## What this task does

Plan and implement durable, retry-on-failure queuing for the GitHub App
webhook review path. After this lands, the same 30-PR burst should produce
30/30 reviews without manual intervention.

## Constraints

- Active gh account must be `antfleet-ops` for any push or PR to the antfleet
  org. `gh auth status` should show that account as Active before any write.
  If it shows `Augustas11`, run `gh auth switch --user antfleet-ops`.
- Repo-level git identity for /Users/augstar/projects/antfleet must be set to
  `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>` so commits
  link to the antfleet-ops GitHub user (the bare `ops@antfleet.dev` address
  used in some older commits does NOT link to a GitHub user).
- Work on a new branch (e.g. `feat/webhook-queue`) off `main`. Open a PR; do
  not push to main.
- The webhook handler must still acknowledge GitHub within the App's webhook
  delivery timeout (10s) — the queue must enqueue fast and return 200, even
  if the actual review takes 5 minutes.
- Idempotency: if the same PR delivery is enqueued twice (GitHub retry, our
  retry, manual push), the system must produce at most one
  `antfleet[bot]` review comment per (installation, owner, repo, pr_number,
  head_sha) tuple.
- Cost: at-least-once delivery is fine; LLM calls are the dominant cost and
  must not be duplicated on retry (use the head_sha-keyed idempotency above).
- No `--no-verify` on commits. No `--force` on any push.

## Solution options to evaluate (planner picks one)

1. **Vercel Queues** (public beta, GA-ish as of early 2026). At-least-once
   delivery, retry semantics, integrates natively with Fluid Compute. Most
   idiomatic for a Vercel + Neon stack. Check current pricing and free-tier
   limits.
2. **Vercel AI Gateway with provider fallback** — addresses the LLM
   rate-limit half of the problem but NOT Vercel function concurrency.
   Probably a complement, not a replacement.
3. **DB-backed queue with cron retry** — cheapest, no new infrastructure.
   New `review_queue` table (status: pending|in_progress|done|failed,
   attempts, next_retry_at). Webhook handler inserts row + returns 200 fast.
   Existing cron at `0 6 * * *` becomes too slow — need a higher-frequency
   cron (or self-trigger via fetch).
4. **QStash / Inngest** (external SaaS) — proven retry semantics. Adds
   a vendor; may or may not be acceptable.

Strongly evaluate option 1 and option 3 in detail. Mention 2 as a possible
complement for the LLM-side rate limit specifically.

## Acceptance criteria

1. Webhook handler returns 200 within 2s for a normal `pull_request.opened`
   delivery (measured locally with a fixture payload).
2. Burst test: 30 simulated webhook deliveries within 60s produce 30
   reviews within 10 minutes total, with zero manual retriggers, on a
   preview deployment. (Use the existing aeon-bench PRs as the burst
   source if cheaper than a synthetic load.)
3. Idempotency test: re-deliver the same webhook payload 3x; exactly one
   `antfleet[bot]` comment posts.
4. Retry test: simulate a 429 from one provider; the review retries with
   exponential backoff and either succeeds or marks the queue row failed
   with a useful error after N attempts.
5. Existing 193-passing test suite still passes. New tests for the
   queuing path (unit + at least one integration).
6. `apps/web/app/api/github/webhook/route.ts:34` TODO comment is removed
   (since the work it describes is now done).
7. Observability: each queue row produces structured log lines on enqueue,
   start, success, failure, and final-give-up. Dashboard or `/api/activity`
   endpoint shows queue depth + recent failures.

## What to read first

Files (in order):
- `apps/web/app/api/github/webhook/route.ts` (538 lines — current inline
  review dispatch; the TODO at line 34 motivates this work)
- `apps/web/lib/review-pipeline.ts` (the `reviewPR` function the queue
  worker will end up calling)
- `apps/web/lib/sweep.ts` and `apps/web/app/api/cron/sweep/route.ts`
  (existing cron pattern — auth via CRON_SECRET + Bearer header)
- `apps/web/db/` (Drizzle schema — the queue table goes here)
- `apps/web/vercel.json` (where any new cron entries land)
- `ARCHITECTURE.md` (whatever's in there about the review pipeline)

External docs to verify before deciding:
- Vercel Queues current status, pricing, region availability
- Vercel function concurrency limits on the project's plan (Pro tier
  default is 10 concurrent; this may already be a bottleneck even with
  a queue if reviews each take 60-90s)

## Out of scope

- Anything Venice-spike related. There is an unrelated active branch
  `spike/venice-consensus` doing other work; do not touch its files.
- Migrating from Anthropic+OpenAI to a different reviewer fleet.
- Rewriting `reviewPR()` itself. This task only changes how it's invoked.

## Handoff message format

When the plan is ready (or the implementation is done, if you take it
through execution), report:
- Solution chosen + why (2-3 sentences)
- Branch name + PR URL
- Test results
- Burst-test evidence (30/30 with zero retriggers)
- Whether the production GitHub App needs a redeploy and whether you
  performed it (running `vercel ls --prod` after deploy is the canonical
  verification step in this codebase)
```

---

## Notes for the operator (you)

- The prompt above is `/omc-plan`, not `/omc-ralph` — it'll plan first, then
  ask for approval before implementing. If you want it to skip planning and
  go straight to execution, replace `/omc-plan` with `/omc-ralph`.
- Run this **after** the Venice spike work either finishes or is paused —
  both touch the antfleet web app's webhook path, so concurrent work would
  conflict.
- Estimated effort: 1-2 days of work depending on which option the planner
  picks. Vercel Queues is faster to ship; DB-backed is cheaper long-term.
- The retrigger script I just ran (`/tmp/retrigger-aeon-bench.sh`) is one-off
  recovery — once this queuing fix lands, it shouldn't be needed again.
