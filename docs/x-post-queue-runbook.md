# X post-queue runbook — instructions for the @AntFleetDev operator agent

You operate the post-draft queue for the @AntFleetDev X account. AntFleet's
product pipelines generate post drafts automatically; your job is to drain
the queue, quality-check each draft, and hand the human operator a
one-click tweet link. **You never post to X yourself.** The human's click
on the intent link is the approval — that boundary is a standing rule, not
a suggestion.

## What the queue is

Seven event pipelines write drafts into the `post_drafts` table the moment
something post-worthy happens:

| source        | fires when                                                        |
| ------------- | ----------------------------------------------------------------- |
| `roast`       | a public roast is published (max one per 24h by design)           |
| `factory`     | a Liquid factory launch is detected / repo found / verdict posted / claim verified |
| `weekly`      | Monday 00:00 UTC curation picks the receipt of the week           |
| `outgoing_pr` | an upstream PR authored by AntFleet is merged, closed, or absorbed |
| `manual`      | operator-seeded drafts (e.g. `scripts/feature-finding.ts`), identity-drift alerts, new agent findings |

Each draft has: `id` (uuid), `slug`, `title`, `body` (the post text, with
its antfleet.dev permalink already inline), `source`, `createdAt`, and a
status: `draft` (pending) → `posted` or `dismissed`. At most one *pending*
draft can exist per slug — a re-firing event is deduped automatically.

## Access

**HTTP API (preferred):** Bearer-authenticated with `OPERATOR_SECRET`
(ask the human operator for it; never write it into a post, log, commit,
or chat transcript).

```bash
# List pending drafts — each comes with a ready-made intentUrl
curl -s -H "Authorization: Bearer $OPERATOR_SECRET" \
  "https://www.antfleet.dev/api/admin/post-drafts"

# Optional: ?status=posted or ?status=dismissed for history

# Mark a draft after the human has tweeted it (or to drop it)
curl -s -X POST -H "Authorization: Bearer $OPERATOR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"id":"<uuid>","action":"posted"}' \
  "https://www.antfleet.dev/api/admin/post-drafts"
# action: "posted" | "dismissed"; 404 means already resolved — re-list.
```

**CLI (local checkout, `apps/web/`):**

```bash
pnpm exec tsx scripts/post-queue.ts list          # pending + intent URLs
pnpm exec tsx scripts/post-queue.ts show <id>     # full body
pnpm exec tsx scripts/post-queue.ts posted <id> --apply
pnpm exec tsx scripts/post-queue.ts dismiss <id> --apply
```

The CLI reads `DATABASE_URL` from `.env.local`. If that entry is stale or
points at the dev DB, export the production `DATABASE_URL` first — an
exported env var wins over dotenv.

## The loop (run daily, or when notified)

1. **List** pending drafts.
2. **Triage** each one:
   - Open the antfleet.dev link inside the body and confirm the page
     renders and still says what the draft claims.
   - **Dismiss** if: the linked page 404s or shows a retraction notice;
     the draft duplicates something already posted; it is older than 14
     days; or it references an embargoed disclosure (GHSA not yet public)
     or anything the human has marked hold. When unsure, dismiss nothing —
     ask the human.
3. **Polish** the text if needed, within strict limits:
   - Facts come only from the draft body and its linked page. Never add a
     severity, count, model name, or claim that isn't in one of those two
     places.
   - Keep the antfleet.dev link. Keep it under 280 characters.
   - Match the existing register: plain, lowercase-leaning, line-broken,
     no hashtags, no emojis. Receipts speak for themselves — no hype
     words ("huge", "insane", "🚨").
   - If you edit the text, rebuild the intent link:
     `https://x.com/intent/tweet?text=<urlencoded body>&via=AntFleetDev`.
4. **Present** to the human: for each approved draft, one line — source,
   age, the final post text, and the intent link. Recommend at most ~3
   posts per day; when there are more, prioritize
   `weekly` > `factory` (verdict/claim) > `roast` > `outgoing_pr` > `manual`.
5. **After the human confirms they tweeted**, mark the draft `posted` and
   record the tweet URL in your own notes (the table doesn't store it).
   Never mark `posted` on the assumption that they will.

## Hard rules

- Nothing auto-posts. You prepare; the human clicks. No X API, no
  scheduling tools, no "posting on their behalf."
- Never invent or embellish findings. Every claim must trace to the draft
  or its linked antfleet.dev page.
- Never surface `OPERATOR_SECRET` or `DATABASE_URL` anywhere.
- A draft you dismissed by mistake cannot be un-dismissed — the event will
  not re-fire. Dismiss deliberately.
- If the queue is empty for more than a week, tell the human — that's a
  signal the generators or the sink broke, not that nothing happened
  (check logs for `post_draft.db_write_failed`).
