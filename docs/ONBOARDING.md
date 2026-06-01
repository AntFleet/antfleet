# AntFleet design-partner onboarding

This page is the operating manual for the third agent in the
AntFleet fleet: **Onboarder**.

AntFleet isn't a SaaS where humans triage your install ticket.
It's a fleet of model-driven agents that act on your repo
autonomously and post receipts of what they did. Three agents
matter for design partners:

- **Reviewer** — two independent frontier models (Claude Opus 4.7
  - GPT-5) read every PR in parallel; only unanimous findings get
    posted. Live since Phase 1.
- **Sweeper** — daily cron at 06:00 UTC; reconciles open findings
  against `main` and posts SHA-pinned closure receipts. Live since
  Phase 1.
- **Onboarder** — owns the partner-facing lifecycle from install
  through first-PR welcome through public-receipt opt-in. The
  agent currently being stood up; see "What's live today" below
  for honest scope.

The point of this doc is to tell you what Onboarder will do, what
it does today (a subset), and where the seams are so you know what
to do manually during the cutover.

## What's live today (honest scope, 2026-05-17)

Onboarder is the next ship on the roadmap, not a single
already-deployed binary. The capabilities below are being moved
from "scripted, run-by-augustas" to "agent, run-by-itself" during
Phase 2. We're being explicit about the seam because trust-
substrate brand demands not overclaiming.

| Capability                   | Today                                 | When the agent owns it                                                                |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| Install URL + scope guidance | static doc (this page)                | static — agents don't need to own static text                                         |
| Welcome on first PR          | nothing posts                         | install webhook → model-authored welcome comment                                      |
| Public-receipts opt-in       | email a maintainer, manual script run | structured email → agent reads → flag flip → reply                                    |
| First-review summary         | Reviewer posts findings, nothing else | Onboarder posts a separate partner-private summary framing what fired and what didn't |
| 7-day check-in               | nothing                               | Onboarder posts reaction-tally + suggested next step                                  |
| Activity feed surfacing      | only review events show               | Onboarder events appear on /activity beside review events                             |

The first three rows are the priority for the next ship; the rest
follow as Phase 2 partner cadence grows.

## What AntFleet does on your repo

Every PR opened against a branch in a repo with the AntFleet
GitHub App installed:

1. AntFleet receives the PR diff via webhook.
2. Reviewer reads the changed files in parallel through two
   independent frontier models (Claude Opus 4.7 and GPT-5).
3. Only findings **both** models flag get posted as a PR comment.
   Disagreements are dropped silently. There is no per-model
   "warning" tier and no aggregator tweak — unanimous-or-nothing.
4. Once the PR merges (or the code in the finding's range no
   longer exists on `main`), Sweeper posts a closure receipt
   comment on the same PR, pinned to the resolving commit SHA.
5. (Soon, via Onboarder) On install and on your first PR, you'll
   get an agent-authored welcome and first-review summary so you
   know what to expect before you have to ask.

No config file. No CI yaml. No dashboards to babysit (yet — v1.5).
AntFleet reviews target one self-contained change per PR — smaller, focused PRs consistently
produce sharper findings (see [Google's small-CL guidance](https://google.github.io/eng-practices/review/developer/small-cls.html)).

## What it costs you during Phase 2

Nothing. Inference is on us. The Phase 2 cohort is free, with a
soft volume cap per partner that we'll communicate before it bites.
Business-model decisions (BYO-API + managed tier with Stripe) are
a v1.5 problem, not yours.

In exchange we ask one thing: keep AntFleet in your default-on PR
review path for ~4–8 weeks, so the receipt corpus accumulates from
real PRs and we get honest signal on false-positive rate, latency,
and what model disagreement looks like in your codebase.

A single review costs ~$0.40 in inference; reviews are capped at
300s wall time and skip rather than truncate on big PRs.

## Install

One URL:

<https://github.com/apps/antfleet/installations/new>

When GitHub asks **which repositories**, we recommend **"Only
select repositories"** and pick one to start. Reviewer runs on
every PR; an "All repositories" install on a busy org will produce
volume you didn't ask for. You can broaden the scope later from
the same screen.

Permissions requested:

- `pull_requests: read` — read PR diff and changed files
- `issues: write` — post the review comment and closure receipt
- `contents: read` — fetch file contents at the PR's head SHA
- `metadata: read` — required for installation-level Onboarder events

Both Reviewer and Onboarder post as `antfleet[bot]`. No human-
account impersonation.

## What you'll see on the first PR

Within ~30–150 seconds of opening a PR, one of two things happens
from Reviewer:

**No comment** — the two models reviewed your changed files and
found nothing they both agree is a real issue. This is the
expected outcome on the majority of PRs. We deliberately tuned
the agreement gate to under-post rather than over-post. Silence
is the default signal.

**One comment titled `AntFleet · review`** — one or more findings
where both models agreed independently. Each finding has:

- A severity (`High` / `Medium` / `Low`) and a category
  (`Security`, `Correctness`, `Performance`, etc.)
- A file path + line range
- A short prose description

We don't post fix suggestions in Phase 2. Patch Bot (the fourth
agent — proposes the fix and pins a closure SHA on apply) is a
Phase 3+ surface.

Once Onboarder ships, a second comment from Onboarder will appear
shortly after your _first_ PR review: a partner-private framing of
what fired, what was filtered, and what to do if it looks wrong.
You'll only see this on the first PR; subsequent PRs are
Reviewer-only output unless something unusual happens.

### Latency

Typical wall-clock for a small PR (≤5 changed files): 30–90s for
Reviewer's comment. Bigger PRs run longer; the webhook function
caps at 300s. PRs that would exceed that are skipped with a
server log entry, not a comment. If you open a multi-hundred-file
PR and nothing posts, that's why — split it.

## Public receipts — opt-in per repo, off by default

The public artifact is <https://www.antfleet.dev/receipts>. When
Sweeper posts a closure receipt on your PR, the entry on that page
shows:

- Severity + category + finding title
- The closing commit SHA (shortened)
- A link to the actual PR comment on GitHub
- An **anonymized repo label** of the form `repo <8-char-prefix>`
  (SHA-256 of `owner/repo`, first 8 chars) — the raw `owner/repo`
  is **not** rendered on the public page.

Two things to know:

1. **Default is off.** Until you opt in, no receipts from your
   repo reach the public counter. Reviewer still runs, the comment
   still posts on your PR, Sweeper still closes findings — but
   the receipts stay private to your install.

2. **For public GitHub repos, the link itself reveals you.** The
   receipt URL points at the actual `github.com/<owner>/<repo>/
pull/N#issuecomment-...` comment, which is publicly visible
   anyway since the repo is public. The anonymized label doesn't
   protect you from someone clicking through. This is intentional:
   the link **is** the receipt, and a third-party-witnessed
   artifact only counts because anyone can verify the SHA on
   GitHub. The opt-in toggle is what controls whether your repo
   participates in this surface at all.

**Opt-in path:** email <agent@antfleet.dev> from any address that
owns or maintains the repo, with the line:

```
Enable public receipts for <owner>/<repo>.
```

`agent@antfleet.dev` is the Onboarder mailbox. Today the address
is live and a human reads it. Once Onboarder ships, the agent
reads it directly, runs the database flag flip, and replies with
confirmation and an ETA on the next receipt — no human in the
loop. The email format above won't change across that cutover;
write to the same address before and after.

To opt out later: same address, "Disable public receipts for
`<owner>/<repo>`." Existing entries disappear from the public
page on next render. Comments on GitHub stay — those are on your
repo's event log, not ours.

## Uninstalling

GitHub repo or org settings → `Installed GitHub Apps` → AntFleet
→ `Configure` → `Uninstall`. The webhook stops firing
immediately and all four agents stop acting on your repo.

To request deletion of historical rows attached to your
`owner/repo` (reviews, finding_status, maintainer_reactions),
email <agent@antfleet.dev> from a maintainer address. We delete
the rows and confirm.

## Where to ask questions and report issues

- **GitHub issues on this repo:**
  <https://github.com/AntFleet/antfleet/issues>
  Bot misbehavior, false positives you want to discuss, install
  problems, anything technical.
- **Private / sensitive:** <agent@antfleet.dev>
- **Public surface:** <https://www.antfleet.dev>
  (`/architecture` explains the agent fleet end-to-end;
  `/activity` is the live feed of what the agents are doing right
  now — worth a glance if you want to see Reviewer or Sweeper in
  flight before installing.)

## What we'd love feedback on in Phase 2

- **False-positive rate on your codebase.** Per finding, did
  Reviewer flag something that wasn't really an issue? We track
  this via maintainer reactions on the posted comment (`👎` or
  `:eyes:` are both useful signal; we don't read content, just
  reaction tallies). Once Onboarder ships, the 7-day check-in
  comment will summarize this back to you.
- **Latency tail.** The 30–90s typical case is fine; the
  occasional 200s+ outlier is worth a flag.
- **Disagreement that should have been agreement.** If you spot a
  real bug in a PR and AntFleet didn't post about it, that's the
  highest-value signal — the agents agreed nothing was wrong
  when something was. Email is fine; GitHub issue is fine; we'll
  dig into the per-model raw responses (which we store) and figure
  out which model dropped it.

That last one is what Phase 2 is for. The unanimous gate is a
strong filter and we expect it to occasionally filter out real
findings. We need real-PR data to calibrate the gate, and that's
exactly what your repo provides.

## The agent fleet (for orientation)

| Agent         | Lives in                                                                        | What it does                                                                        | Status   |
| ------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------- |
| **Reviewer**  | `apps/web/lib/review-pipeline.ts` (calls `src/providers/{anthropic,openai}.ts`) | Two-model unanimous gate on every PR                                                | Live     |
| **Sweeper**   | `apps/web/lib/sweep.ts`                                                         | Daily cron; closure receipts pinned to merge SHA                                    | Live     |
| **Onboarder** | `apps/web/lib/onboarder.ts`                                                     | Install welcome, first-review summary, 7-day check-in, partner_reply signal capture | Live     |
| **Patch Bot** | not yet implemented                                                             | Proposes fixes; pins closure SHA on apply                                           | Phase 3+ |

The fleet is open source under MIT
(<https://github.com/AntFleet/antfleet>). The agents you don't see
yet on `/activity` aren't sleight of hand — they're the roadmap,
shipping in order of trust-substrate value.

---

Document last updated: 2026-05-17. Canonical version:
<https://github.com/AntFleet/antfleet/blob/main/docs/ONBOARDING.md>.
