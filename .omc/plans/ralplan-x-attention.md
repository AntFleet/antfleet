# Ralplan consensus: X-attention sprint (OG images + tweet intents + weekly digest)

Status: **pre-approved for execution** (operator approved in chat 2026-05-19).
Branch: `feat/x-attention-og-digest`.
Sequence: post-Sprint-4, pre-Sprint-5.

This file is shaped to autopilot's consensus-plan detector — its presence at `.omc/plans/ralplan-*.md` instructs the autopilot skill to skip Phase 0 (Expansion) and Phase 1 (Planning) and jump straight to Phase 2 (Execution). The chunks below are the Phase 2 input.

---

## RALPLAN-DR summary

### Principles

1. **Every artifact AntFleet produces should preview as a card on X.** Receipts, agents, roasts, and weekly digests each need a 1200×630 og:image. No artifact should preview as the small `summary` Twitter card it does today.
2. **The number on a tweet must equal the number behind the link.** `/activity` "receipts closed all-time" (41) and `/receipts` (32) currently disagree. Public-facing copy uses the public-receipt-gated count or nothing.
3. **Weekly cadence, not daily.** Live data shows last-24h is mostly zero closures; last-7d is the smallest window with reliably non-zero material.
4. **Reproducible permalinks.** A digest URL rendered today and re-rendered next week must produce a byte-identical OG image. That requires an upper bound on the window, not "since X to now."
5. **All coding via Codex per Sprint 4 contract.** `OMC_SHELL_READY_TIMEOUT_MS=90000 omc team 1:codex` for every implementation chunk; Claude handles copy, integration, migrations, runbook, PR body, commit messages. Security-reviewer agent runs on any new attacker-reachable route.

### Decision drivers (top 3)

1. **Maximize X-attention without compromising the trust-layer brand.** The receipts-are-the-artifact thesis means every share is also a brag — but only if previews land.
2. **Don't disrupt Sprint 5 (Public JSON API).** This work touches *presentation* + one shared helper (`activityWindow()`); Sprint 5 touches *transport*. Concurrent execution OK; the activityWindow signature change is sequenced first so Sprint 5 inherits it.
3. **Fix three real counter mismatches that any digest tweet would otherwise inherit and amplify.** Specifically: (a) `/activity` not gated by `public_receipt`; (b) handoff gate-check counts reviews instead of closed findings; (c) `reactionsObserved=0` everywhere because of the krisskross_shops orphan rows.

### Viable options considered

**Option A — chosen: ship the og-image layer + tweet intents + weekly digest + roasts index, all behind the existing schema.** No new tables, no new external integrations, no autoposter. Five Codex chunks, ~2 days end-to-end. Maximizes content surface per hour invested.

**Option B — rejected: add `outgoing_posts` table + admin promote-to-tweet pipeline + Twitter API integration.** Rejected for v1: introduces operator workflow, API credentials, and a moderation queue that mirrors the roast-moderation pattern without yet proving the simpler manual-tweet flow is the bottleneck. Reconsider after 4 weeks of operator-tweeted digests, when the throttle is human-attention rather than capacity.

**Option C — rejected: build a leaderboard / hall-of-receipts page first.** Sprint 6 gate (N≥5 agents) blocks this; only 1 agent on file. Premature.

### Pre-mortem (deliberate mode)

| Scenario | Likelihood | Mitigation |
|---|---|---|
| OG images render with system fonts that differ across CDN edges, producing visual drift between previews and the rendered card | Low | Use Next's `nodejs` runtime for `opengraph-image.tsx` (not edge) so the same `node` version renders everywhere. Snapshot the rendered PNG in a test. |
| `activityWindow()` gate change drops the `/activity` numbers visibly (41→32) and looks like a regression | High | Pair the change with a copy update on `/activity` clarifying the gate, and ship in the same commit. The drop is real and intentional; surface the *why*. |
| Digest page is hit with invalid date strings — `/digest/invalid`, `/digest/2026-13-99`, `/digest/'; DROP TABLE` | High | Strict YYYY-MM-DD parse in `loadDigestForWeek()`; reject anything else with `notFound()`. security-reviewer agent reviews specifically this route. |

### Expanded test plan (deliberate mode)

- **Unit:** `activityWindow(since, until)` covers four cases — both null, since only, until only, both set. Gated/ungated parity tested.
- **Unit:** `loadDigestForWeek()` covers — invalid date, future date, empty week, top-3 ordering by severity, the 9-row gated/ungated gap shows up correctly.
- **Integration:** each new `/opengraph-image.tsx` route returns 200, `Content-Type: image/png`, ≥50 KB.
- **Integration:** `/digest/<known-friday>` renders top-3 closures from that week.
- **E2E:** smoke test posts the page URL to a private X test thread; verify card previews with title + image (manual; documented in PR body).
- **Observability:** structured log line on each digest page load: `{ "weekEndingAt": "...", "receiptsClosed": N, "renderMs": M }`. No PII.

---

## ADR

**Decision.** Ship five chunks (CODEX-1..5) that together convert AntFleet's existing artifacts into self-previewing X content, plus fix the public-receipt gate on `/activity` counters and add `until` bounding to `activityWindow()`.

**Drivers.** See "Decision drivers" above.

**Alternatives considered.** Options B (autoposter pipeline) and C (leaderboard) — both rejected; rationale above.

**Why chosen.** Option A maximizes leverage per hour: every Codex chunk is contained, the data layer is already done, no new schema, no new external service, no new credentials. The five chunks ship value independently — even partial completion (just CODEX-2 OG images) materially improves AntFleet's X presence.

**Consequences.**
- `/activity` headline numbers will drop (41→32 for "receipts closed all-time"). Required copy update.
- New routes: `/digest/[yyyy-mm-dd]`, `/roasts` (index). Both `force-dynamic` for v1; can flip to `generateStaticParams` in iteration 2.
- One new component: `apps/web/components/TweetIntent.tsx`. No new dependencies.
- Three new `opengraph-image.tsx` files use Next.js `ImageResponse`; runtime: `nodejs`.

**Follow-ups (NOT in scope for this sprint).**
- `outgoing_posts` table + admin queue (Option B) — reconsider after 4 weeks of manual operator tweeting.
- `/wall` hall-of-receipts grid — gate on N≥50 closed public receipts.
- Week-over-week delta arrows on `/digest` — gate on N≥2 prior weeks of digest data.
- Daily digest cadence — explicitly rejected by data analysis.

---

## Pre-flight ops (Claude executes directly — NO Codex, NO PR)

These three steps unblock the rest. Run before opening the branch.

1. **Orphan reaction-poller row cleanup.** Unblocks `reactionsObserved` becoming non-zero.
   ```bash
   cd apps/web
   DATABASE_URL="$(grep '^DATABASE_URL=' .env.local.bak.prod-main | cut -d= -f2- | tr -d '"')" \
     pnpm exec tsx -e "
       import { neon } from '@neondatabase/serverless';
       const sql = neon(process.env.DATABASE_URL!);
       await sql\`UPDATE finding_status SET status='superseded'
                 WHERE review_id='83e79770-1869-4331-8690-b534a531d327'\`;
     "
   ```

2. **Flip AntFleet/antfleet dogfood opt-in.** Closes the 41-vs-32 gap.
   ```bash
   cd apps/web
   DATABASE_URL="$(grep '^DATABASE_URL=' .env.local.bak.prod-main | cut -d= -f2- | tr -d '"')" \
     pnpm exec tsx scripts/enable-public-receipts.ts AntFleet antfleet
   ```

3. **Fix the handoff gate-check snippet** in `.omc/plans/handoff-sprints-5-6.md` — replace the `reviews.public_receipt = true` count with the closed-findings join (see "Implications" section of the analysis chat). Prevents the next session repeating the reviews-vs-receipts conflation.

---

## Phase 2 execution chunks

Working contract for every chunk:
```bash
OMC_SHELL_READY_TIMEOUT_MS=90000 omc team 1:codex \
  "Read .omc/codex-out/xattn-NN-<slug>/TASK.md and execute it. \
   Strict rule: write ONLY under .omc/codex-out/xattn-NN-<slug>/ \
   and the file scope listed in TASK.md. Touch DONE last."
```

Codex writes patches under `.omc/codex-out/xattn-NN-<slug>/`. Claude integrates each chunk's diff into the actual file scope before launching the next chunk.

### CODEX-1 · `xattn-01-activity-window-bounds`

**File scope:** `apps/web/db/queries.ts` + the existing test file that covers `activityWindow` (find via `grep -l activityWindow apps/web/db/*.test.ts apps/web/lib/*.test.ts`).

**Task:**
- Extend signature: `activityWindow(since: Date | null, until: Date | null = null): Promise<ActivityWindow>`. When `until === null`, behavior is "up to now" (matches current).
- Apply `inner join reviews on reviews.review_id = finding_status.review_id` + `eq(reviews.publicReceipt, true)` to **all four** counters in `activityWindow()` ([queries.ts:1129](apps/web/db/queries.ts:1129)). The `reviews` and `maintainerReactions` counts also need the gate (reactions are polled on opted-in findings only).
- Update callers in `loadFleetActivity()` at [queries.ts:760](apps/web/db/queries.ts:760) — no signature change at call sites since `until` defaults to null.
- Add test cases: (a) bounded window returns subset, (b) gated < ungated when non-opted-in rows exist, (c) `until < since` returns zero counters, (d) `until` in the future is clamped to now.

**Why first:** unlocks CODEX-4 (digest needs bounded reproducible windows) and removes the 41→32 mismatch any digest would inherit. Sprint 5 also benefits — the public JSON API can reuse the gated counter helper directly.

**Verification:** `pnpm -F @antfleet/web test` green; `/activity` page numbers visibly drop (intentional); a manual check that `/activity` "last 7d" matches the `count(*)` shown at the top of `/receipts` for the same window.

### CODEX-2 · `xattn-02-og-images`

**File scope:** three new files; no existing files touched.
- `apps/web/app/receipts/[id]/opengraph-image.tsx`
- `apps/web/app/agents/[address]/opengraph-image.tsx`
- `apps/web/app/roasts/[id]/opengraph-image.tsx`

**Task:** Each file exports default `async function` returning `ImageResponse` from `next/og`. Runtime: `nodejs` (queries hit Neon over HTTP). Size: 1200×630. Background `#0a0a0a`, ink `#ffffff`, line `#27272a`, accent ink-muted `#a1a1aa`. System fonts only (no `next/font` remote fetch — matches existing no-third-party-fonts rule in `apps/web/app/layout.tsx`).

**Per-route shape:**
- **receipt:** top bar with `antfleet[bot]` + `closed in <sha7>` · severity pill (border-rounded, monospace) · category pill · finding title (3xl, semibold) · `repo <hash-prefix>` + PR number · bottom footer `antfleet.dev/receipts/<short-id>`
- **agent:** `Public investigation` label · agent display name + short address (`0x1234…abcd`) · big findings count (6xl tabular-nums) · highest severity pill · footer `antfleet.dev/agents/<short-addr>`
- **roast:** `AntFleet roast` label · repo full name (3xl) · status badge (queued / running / published / rejected) · published-only: finding count + highest severity · footer `antfleet.dev/roasts/<id>`

**Data fetch:** existing loaders only — `loadReceiptDetail`, `loadAgentDetail`, `loadRoastDetail`. If loader returns null, return a 404-shaped image with the AntFleet wordmark and "not found." Never throw.

**Verification:** `curl -I https://<preview>/receipts/<id>/opengraph-image` → 200, `image/png`, ≥50 KB. Snapshot rendered PNG byte-count in a test. Visual smoke: render with `<img src="…">` in a scratch HTML file, confirm typography is readable at 600×315 (Twitter's downscale).

### CODEX-3 · `xattn-03-tweet-intents`

**File scope:**
- New: `apps/web/components/TweetIntent.tsx`
- Edit: `apps/web/app/roasts/[id]/page.tsx` (`ShareSection` only)
- Edit: `apps/web/app/receipts/page.tsx` (add per-row "Tweet ↗")
- Edit: `apps/web/app/agents/[address]/page.tsx` (header area)

**Task:**
- Component: `<TweetIntent text url via?="AntFleetDev" className?>`. Renders `<a target="_blank" rel="noopener noreferrer" href="https://x.com/intent/tweet?…">` with URL-encoded `text`, `url`, `via`. No client JS, no state.
- Insert into `ShareSection` at [roasts/[id]/page.tsx:303](apps/web/app/roasts/[id]/page.tsx:303) when `submission.status === "published"`, above the existing `CopyBadgeSnippet`.
- Add per-row tweet affordance on `/receipts` listing — small `Tweet ↗` link beside each receipt.
- Add agent tweet button near the agent header on `/agents/[address]`.
- Insert copy placeholders `__TWEET_COPY_RECEIPT__`, `__TWEET_COPY_ROAST__`, `__TWEET_COPY_AGENT__` — Claude finalizes voice after Codex commits scaffold.

**Voice templates (Claude swaps in during integration step, not Codex):**
- receipt: `"AntFleet caught a <severity> <category> bug in <repo-hash>. Closed in <sha7>. Two frontier models, both agreed."`
- roast: `"AntFleet just roasted <repo>: <N> agreed findings."`
- agent: `"Public investigation on <agent-name> (<short-addr>): <N> findings on file."`

**Verification:** rendered HTML on each page has a working `x.com/intent/tweet` href with non-empty params; `via=AntFleetDev` appears on all three.

### CODEX-4 · `xattn-04-digest-page`

**File scope:**
- New: `apps/web/app/digest/[yyyy-mm-dd]/page.tsx`
- New: `apps/web/app/digest/[yyyy-mm-dd]/opengraph-image.tsx`
- New: `apps/web/lib/digest.ts`
- Edit: `apps/web/db/queries.ts` (add `loadTopClosuresBetween(since, until, limit)` helper)

**Task:**
- `loadDigestForWeek(weekEndingIsoDate: string)` in `apps/web/lib/digest.ts`:
  - Parse `YYYY-MM-DD` as UTC midnight. Reject anything else via `null` return.
  - Compute `since = ending - 7d`, `until = ending`.
  - Reject `until > now()` (future week) via `null`.
  - Returns `{ since, until, counts: ActivityWindow, topClosures: PublicReceiptRow[] }` (top 3 by severity-rank within the window).
- Page renders: hero with the week's date range, big counter row `{ reviewsRun · findingsAgreed · receiptsClosed }`, the top-3 closures formatted like `/receipts` rows, `<TweetIntent>` prefilled with `"AntFleet · week of <date>: <N> receipts closed across <M> PRs. Top: <title-1>."`, footer with stable permalink and `<rel="canonical">` tag.
- `dynamic = 'force-dynamic'`. Skip `generateStaticParams` for v1.
- Edge cases: invalid date → `notFound()`. Future date → `notFound()`. Empty week → render counters with zeros and a single line "no closures this week" instead of an empty top-closures section.
- **Explicitly NOT in scope:** week-over-week delta arrows, archive index, RSS feed. Defer to iteration 2.

**Verification:** `/digest/2026-05-16` renders. `/digest/invalid` and `/digest/2026-13-99` and `/digest/9999-01-01` all 404. The opengraph-image route returns a PNG. Re-rendering the same digest URL produces byte-identical OG image bytes (reproducibility test).

**Security review gate:** spawn `security-reviewer` subagent after Codex commits this chunk. Specific focus: date string parsing in `loadDigestForWeek()`, no SQLi via the route param, `notFound()` on every rejection path.

### CODEX-5 · `xattn-05-roasts-index-and-counter`

**File scope:**
- New: `apps/web/app/roasts/page.tsx`
- Edit: `apps/web/app/roast/page.tsx` (add counter strip above form)
- Edit: `apps/web/app/layout.tsx` (add `/roasts` to header nav between `/agents` and `/roadmap`)
- Edit: `apps/web/db/queries.ts` (add `loadRoastStats()` returning `{ totalPublished, totalFindingsFromRoasts }`; add `loadPublishedRoasts(limit, before?)` for the index page)

**Task:**
- `/roasts` lists `status='published'` submissions, newest first, repo full name visible, finding count, severity-of-highest, relative timestamp. Paginated via `before=` cursor (mirrors `/receipts` pattern).
- `/roast` counter strip: `"<N> repos roasted to date · <M> findings filed"` above the form. Renders as a small monospaced line in `--color-ink-subtle`, consistent with existing visual language.
- Header nav addition is a single `<a href="/roasts">roasts</a>` between `/agents` and `/roadmap` in `apps/web/app/layout.tsx`.

**Why this chunk last:** depends on CODEX-3's `<TweetIntent>` being available (each roast row gets a tweet button). Independent of CODEX-1/2/4.

**Verification:** `/roasts` renders the autonomopoly seed roast. `/roast` counter shows non-zero after dogfood opt-in flip from pre-flight step 2. Header nav has new link visible on every page.

---

## Phase 3 (QA) gates

After all five chunks integrated:
- `pnpm lint` → 0 errors
- `pnpm format:check` → clean
- `pnpm -F @antfleet/web test` → 321 + new tests passing
- `pnpm -F @antfleet/web build` → green
- Up to 5 cycles on test failures; same error 3× → escalate to operator

## Phase 4 (Validation) — parallel agent review

After QA green, spawn in parallel:
- **architect** subagent — functional completeness against this plan's chunks
- **security-reviewer** subagent — focus on `/digest/[yyyy-mm-dd]` route param handling and `<TweetIntent>` URL construction (XSS in tweet text)
- **code-reviewer** subagent — quality / style / typing

All three must approve. Rejections → fix → re-validate (max 3 rounds).

## Phase 5 (Cleanup + ship)

- Update `.omc/plans/antfleet-runbook.md` §3 with the new routes and the activityWindow signature change.
- Commit author: `antfleet-ops <285575208+antfleet-ops@users.noreply.github.com>` per memory rule.
- PR body via `--body-file /tmp/xattn-pr-body.md` (never inline backticks).
- `gh auth switch --user antfleet-ops` before push.
- `vercel ls --prod` post-merge — confirm new deploy Ready and latest commit matches.
- Delete `.omc/state/autopilot-state.json`, `ralph-state.json`, `ultrawork-state.json`, `ultraqa-state.json` per autopilot Phase 5.

---

## Entry command (operator runs)

```bash
cd /Users/augstar/projects/antfleet
git checkout main && git pull --ff-only
git checkout -b feat/x-attention-og-digest

# Then in the Claude Code session:
/autopilot Ship the X-attention layer per .omc/plans/ralplan-x-attention.md.
ALL coding via OMC_SHELL_READY_TIMEOUT_MS=90000 omc team 1:codex.
Skip Receipt-of-the-Week auto-populate (parallel session).
```

Autopilot detects this consensus plan, skips Phase 0+1, and starts at Phase 2 (Execution) with the five chunks above.
