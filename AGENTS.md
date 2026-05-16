# AntFleet — Project Substrate

> **Trust substrate for autonomous code work.** Multi-model verification. SHA-pinned receipts. Marketplace under the hood.

This file is the canonical strategy + context document for AntFleet. A fresh session should be able to read this top-to-bottom (~15 minutes), then load `ARCHITECTURE.md` for technical context and `examples/dogfood-results/WEEK1-VERDICT.md` for empirical data, and pick up active work without additional briefing.

**Last updated:** 2026-05-16 (post-Week-1 verdict, pre-Phase-0, brand-unified-as-AntFleet)

## Naming hierarchy (read first if you've seen older docs)

| Layer | Name | Role |
|---|---|---|
| Protocol | **AntSeed** | Underlying inference-payments protocol (external — we contribute, we don't own) |
| Community / consumer | **Antfeed** | Colony Scout persona on X / Farcaster — marketplace discovery, daily snapshots, lowercase third-person voice |
| Marketplace + product | **AntFleet** | The b2b product. The marketplace IS the product — a fleet of inference agents running on customer repos |

"AntFleet" is the unified brand. Earlier internal drafts used "Antfeed Fleet" — that name is retired. "Antfeed" remains as the community brand for the marketplace discovery / Colony Scout social presence, but the product and marketplace substrate is AntFleet.

---

## 1. What this file is (and isn't)

**This file IS:**
- The strategic substrate that survives across sessions
- The decision log for locked choices (with rationale)
- The roadmap-in-phases with explicit decision gates between phases
- The list of open strategic questions

**This file IS NOT:**
- Implementation specs — those live in `ARCHITECTURE.md`
- Empirical data — that lives in `examples/dogfood-results/*.md` and `examples/antseed-corpus-results/*.md`
- Autopilot mission prompts — those are generated per-mission
- Marketing copy — the landing page is the marketing copy

When a decision changes, update this file. When an experiment runs, write a verdict file. Don't confuse the two.

---

## 2. Vision

**One line:** AntFleet is the trust substrate for autonomous code work.

**One paragraph:** AntFleet runs every PR through N independent frontier models from the Antfeed inference marketplace and posts only the findings they agree on. **The value proposition is precision, not coverage.** When two independent frontier reviewers both flag the same code, 6 runs of real-repo data (V2 + V3 Phase 0 verdicts) show the finding is real ~100% of the time — zero hallucinated bugs in the agreement set. We don't promise to catch the bugs you already knew about; we surface fewer-but-real ones you wouldn't have written up yourself. Every closed finding is pinned to a resolving commit SHA — the receipt that proves the audit was real. The same substrate later runs Sweeper (reconciles old findings), Patch Bot (writes the fix), and Security/Perf specialists — all from one webhook. The wedge is the marketplace under the hood: nobody else can stack N models cheaply enough to make agreement the trust primitive. The moat is the receipts: a public, growing, cryptographically-provable counter of AI-resolved findings.

---

## 3. What AntFleet IS / IS NOT

**IS:**
- A GitHub App that reviews PRs via multi-model agreement
- A managed service with a public receipts counter as the trust artifact
- A marketplace substrate that opens to third-party providers in v2 and to agent authors in v3
- Branded as the serious b2b sibling of Antfeed (the Colony Scout marketplace persona stays for community/social)

**IS NOT:**
- A CLI tool (clawpatch is one — we forked it but the product is not the CLI)
- An IDE or in-editor experience (don't compete with Cursor)
- A single autonomous coding agent (don't compete with Devin)
- "The next Snyk / CodeRabbit / Greptile" (don't position by competitor)
- Tied to AntSeed in product copy (AntSeed is one provider source among many, marketing-invisible)

---

## 4. Current status

**Repo state:**
- Forked from clawpatch (MIT, https://github.com/openclaw/clawpatch) at upstream commit `b03bf52`
- Week 1 deliverables landed: scaffold, ARCHITECTURE.md, stacked provider abstraction, anthropic + openai + openrouter providers, dogfood corpus, 5-iteration baseline, WEEK1-VERDICT.md

**Week 1 empirical findings:**

| Provider | Findings/run | Ground-truth caught | Precision | Recall |
|---|---|---|---|---|
| Anthropic Opus 4.7 | ~9–10 | 5/5 | ~55% | 100% |
| OpenAI GPT-5 | ~6–7 | 4.8/5 | ~80% | 96% |
| OpenRouter / DeepSeek-V3 | 1 | 1/5 | 100% | 20% |

| Agreement mode | Agreed/run | Bugs caught | Verdict |
|---|---|---|---|
| Unanimous-3 | 0.8 | 0.8/5 (16%) | **RED** — DeepSeek collapses the floor |
| Majority-3 | 5.0 | 4.4/5 (88%) | Strong |
| Any | 10.2 | 5.0/5 (100%) | Just union noise |

**Locked decision from Week 1:** Drop DeepSeek/OpenRouter from default. Ship MVP with Anthropic + OpenAI in 2-provider unanimous mode. Receipts are the moat. Agreement is the quality gate.

**Phase 0 verdict (V2 + V3, 2026-05-16):** Both **RED** on recall against the curated AntSeed ground truth (V2: 13%, V3: 7% matcher / 0% hand-scored clean). V3 ruled out the transport-truncation hypothesis (zero failures at `max_tokens=16384`, but recall dropped further as each provider produced more divergent findings). The signal-quality story is robust across both verdicts: **0% misidentifications in unanimous mode across 6 runs.** The stack does not hallucinate — it surfaces real bugs that don't always overlap a human's prioritized write-up list.

**Locked decision from Phase 0 (2026-05-16):** Pitch **(b)** is the value proposition — "fewer-but-real bugs you wouldn't have written up yourself." Precision, not coverage. This aligns with the receipts-as-moat thesis (§18.2): every receipt is provably real, never required to align with any prior expectation. Phase 1 unlocked. Phase 0 RED verdict on recall is logged honestly per §12 and folded into the customer-visible pitch, not papered over.

**Mission 1 — complete (2026-05-16 → -17):**

| Slice | Commit | Delivers |
|---|---|---|
| 1 | `c75f187` | Next.js 16 + Drizzle schema scaffold |
| 2 | `673f995` | Webhook HMAC verification + structured logging |
| 3 | `ed152e0` | Neon Postgres + GitHub App auth + stub-row dispatcher |
| 4a | `7dc862a` | Workspace exports + Octokit file fetcher |
| 4b | `6053efe` | Real review pipeline (anthropic+openai parallel) |
| 4b.1 | `be9704d` | Agreement gate (degraded ⇒ no comment) + tight prompt |
| 4b.2 | `08d673a` | Anthropic `{input:{…}}` unwrap |
| 4c | `ed6c971` | PR comment posting via Octokit |
| 4d | `3ab052a` | Generalized unwrap + `inspected` tolerance, real-PR e2e via smee |

End-to-end demo working: GitHub PR → smee → localhost → 2-of-2 unanimous → markdown comment on the PR. Live evidence on `Augustas11/krisskross_shops` PR #1 (comments `#issuecomment-4466966392`, `#issuecomment-4467326988`, `#issuecomment-4467353797`).

**Mission 3 — in progress:**

| Slice | Commit | Delivers | Status |
|---|---|---|---|
| 3-1 | `63af2e2` | `finding_status` table + `pr_comment_id` persistence | ✓ |
| 3-2 | `79c7a55` | `classifyFindings` + `detectClosures` primitives | ✓ |
| 3-3 | `a9b842a` | `formatClosureReceipt` + extended `markFindingClosed` | ✓ |
| 3-4 | `a63adde` | `pollReactions` + `mapToMaintainerReactions` + `recordMaintainerReactions` + dedup unique index migration `0002_lush_nighthawk` | ✓ |
| 3-5 | _pending commit_ | `/api/cron/sweep` orchestrator + `runSweep` + `loadSweepWork`/`stampFindingPolled` + `sweep-data` JSONB extractors + reviews coord cols migration `0003_high_maggott` + webhook persists coords | ✓ |
| 3-6 | — | `vercel.json` cron schedule | next |

**Next mission:** Mission 3 slice 3-6 (`vercel.json` cron schedule + `CRON_SECRET` env). See `HANDOFF.md` at repo root for the resume sequence and any session-specific state.

---

## 5. The 4-phase roadmap

### Phase 0 — Lock the stack (this week, ~1 day)

- Unregister openrouter and codex providers (keep files for v2)
- Default `--providers anthropic,openai --mode unanimous`
- Sanity-check against AntSeed using 5 gated bugs from `~/antseed-agent/findings/BUGS.md` as ground truth
- Produce `examples/antseed-corpus-results/WEEK1-VERDICT-V2.md`
- GO/NO-GO gate for Phase 1

### Phase 1 — MVP build (weeks 2–4, ~3 weeks)

Four sequential autopilot missions:

1. **GitHub App skeleton** — install flow, OAuth, webhook handler, repo cloning, audit trail, **structured data tables (see §10)**
2. **Review pipeline + PR comment posting** — webhook → review changed files → 2-provider unanimous → post agreed findings as PR comment, capture full per-provider response
3. **Sweeper + receipts + maintainer-reaction polling** — daemon reconciles old findings against `main`, posts "closed BUG-XXX in <SHA>" comments, polls for maintainer reactions at 24h/7d/30d
4. **Landing page + public receipts page + data policy** — Next.js single-pager, live receipts counter as hero, install button, data-policy footer

**MVP launch milestone:** 1 design partner repo live, public receipts counter > 0.

### Phase 2 — Design partners + iteration (weeks 5–8, ~1 month)

- 5–10 design partner repos onboarded (free tier, rate limits, no Stripe yet)
- Weekly metrics review: per-repo recall, noise, time-to-close
- First customer NPS-style signal
- **Week-8 decision gate:** what are customers actually asking for? That shapes Phase 3 scope.

### Phase 3 — v1.5 (months 3–6)

Features design partners actually pulled (not the ones we predicted). Most likely:

- Suggested-patch mode (read-only, no auto-merge)
- Per-customer dashboard
- Stripe billing (usage-based: PR volume × providers)
- **2C: Eval harness + routing v1** — the intelligence layer using MVP-captured data
- Slack/Discord integrations
- Specialist members (security, perf) sold à la carte

### Phase 4 — Fleet expansion (months 6–12)

Three strategic forks land here:

- **Fork A — Auto-PR / Patch Bot.** Trigger: ≥60% of v1.5 suggested-patch findings accepted within 30 days
- **Fork B — Marketplace-as-router vs marketplace-as-voter.** Real-repo data over months 3–6 decides
- **Fork C — Fleet packaging.** Once 3+ specialist members exist, repackage as "Managed Agent Fleet" with presets

---

## 6. Provider stack (v1 and roadmap)

### v1 stack (locked)

| Provider | Model | Role |
|---|---|---|
| Anthropic | claude-opus-4-7 | Broad-net reviewer, high recall |
| OpenAI | gpt-5 | Balanced reviewer, best signal-to-noise |
| Mode | unanimous | Both must agree on category + overlapping evidence |

Rationale: `examples/dogfood-results/WEEK1-VERDICT.md`.

### Deferred to v2 (kept in tree, unregistered in `providerByName`)

- **openrouter** (DeepSeek-V3 / Qwen Coder fallback) — re-evaluate as triage voter or specialist
- **codex** (OpenAI Codex CLI) — re-evaluate when env requirements stabilize

### v2 considerations (data-driven, not yet decided)

- Same-family-different-size pair (Claude Opus + Claude Sonnet) for intra-family stacking
- Gemini 2.0 Pro for true cross-family diversity
- Open the provider marketplace — third parties register and bid on review requests

**Strategic principle:** Don't add providers until real-repo data shows where the 2-provider stack misses. The thesis ("more providers = better") was falsified for price-stratified diversity (DeepSeek). Stay disciplined.

---

## 7. The three flywheels

| Flywheel | Mechanism | Compounding | Time to inflection |
|---|---|---|---|
| **Trust** | Receipts counter grows → social proof → conversions | Linear-ish | 3–6 months post-MVP |
| **Data** | (Finding, agreement-state, resolution-SHA, reaction) tuples → routing intelligence + prompt tuning + evals | Compounding | 12–18 months |
| **Network (marketplace)** | More providers compete → cheaper/better → more customers → more attractive to providers | Two-sided compounding | 18–36 months |

**Disagreement is unique IP.** Nobody else has cross-model disagreement data on real customer code. This is the substrate for routing decisions, evals, and (eventually) calibration models. Anthropic has Claude's outputs. OpenAI has GPT's. Only AntFleet has "where these two disagree on real customer code, and which side was right."

**Sequencing rule:** Can't open the network flywheel before the trust flywheel produces visible signal. Can't compound the data flywheel before meaningful review volume exists. Order is mechanical: trust (MVP→month 3) → data (months 3–9) → network (months 9–18) → agent marketplace (year 2+).

---

## 8. The marketplace endgame — three earning paths

| Path | Who | What they do | Earn | When viable |
|---|---|---|---|---|
| **1. Provider (supply-side)** | Anyone with model-serving capacity | Register on marketplace, bid on review requests | Per-call fees, paid in fiat or AntSeed credits | v2 (months 6–12) |
| **2. Agent Author** | Specialists | Write specialized agents customers install ("SOC2 auditor", "Solidity security", etc.) | 50–70% rev-share | v3 (year 2) |
| **3. Data Contributor** | Customers + 3rd parties | Contribute curated (bug, fix, severity) pairs to eval corpus | Credits / rev-share | v1.5–v2 (months 6–12) |

**Critical principle:** Open the marketplace only after the trust flywheel is producing visible signal AND the data flywheel is meaningfully compounding. Premature marketplace = thin supply, thin demand, no flywheel — three sides of an empty room.

**The eventual prize:** in a fully-built Antfeed, a specialist can write an agent in their spare time, upload it to the marketplace, and earn $4–8K/mo passively while the network of providers does the inference. Two-sided market with three supply sides (inference, agents, data) and one demand side (customers paying for review outcomes).

**MVP is the door. The marketplace is the building behind the door.**

---

## 9. MVP scope (Phase 1)

### Must-have for v1

- GitHub App: webhook on PR, post comment, install flow, OAuth
- 2-provider review pipeline (Anthropic + OpenAI, unanimous, on changed files only — not whole repo)
- Audit trail with structured persistence (see §10)
- Sweeper running daily, posting "closed BUG-XXX in <SHA>" receipts
- Public receipts page (`/receipts`) with live counter
- Landing page (1 page, install button as primary CTA)
- Data policy in ToS and footer (opt-in for eval corpus contribution)

### Defer to v1.5

- Patch Bot (write permission, suggested-patch mode first)
- 3rd provider / model routing / cost optimization
- Multi-tenancy beyond single GitHub org per install
- Stripe billing
- Per-customer dashboard
- Eval harness, routing v1, benchmark suite (uses MVP-captured data)
- Specialist members (security, perf)

### Explicitly skip in MVP

- CLI, IDE plugin, in-editor anything
- Configurable agreement modes — opinionated unanimous-on-2 only
- Marketing site beyond a single landing page
- Auth-as-a-service — GitHub App OAuth is the auth
- Any DAO / token / on-chain anything in product surface (even though AntSeed underneath may use those)

---

## 10. Data capture commitments (Phase 1 architectural)

**These cost ~1–2 days extra in MVP and unlock Phase 3's eval/routing work without retrofit.**

### Two Postgres tables from day 1

**`reviews`** — every review request:
```
review_id              uuid pk
repo_hash              text  (anonymized at write)
pr_number              int
commit_sha             text
files_reviewed         text[]
prompt_version         text
provider_model_ids     jsonb  ({"anthropic": "claude-opus-4-7", "openai": "gpt-5"})
provider_responses     jsonb  (full per-provider output, schema-versioned)
agreement_decision     jsonb  (which findings passed, which were filtered, why)
timing_ms              int
cost_estimated_usd     numeric
schema_version         int
created_at             timestamptz
```

**`maintainer_reactions`** — implicit RLHF signal:
```
reaction_id            uuid pk
review_id              uuid fk
finding_id             text
action_taken           text  (accepted/closed/ignored/commented)
reaction_at            timestamptz
maintainer_comment     text  (nullable)
polled_at              timestamptz
```

### Polling job

Daily cron polls each posted-PR comment for new reactions. Checkpoints at 24h / 7d / 30d after PR open. This is the most valuable signal in the entire system — what got accepted vs ignored.

### Versioning rules

- `prompt_version` increments on every prompt change
- `provider_model_id` records exact model version string
- `schema_version` increments on schema changes
- Allows splitting historical data by version for valid before/after comparisons

### Anonymization at write time

- Hash repo identifier; redact filenames for aggregate analysis
- Aggregate data is privacy-safe by construction
- Per-customer data accessed only via explicit auth

---

## 11. Architectural commitments (v2-readiness baked into v1)

These don't add features to MVP. They prevent v2 from requiring a rewrite:

1. **Strict provider abstraction.** No vendor-specific code outside `src/providers/<vendor>.ts`. Adding a 3rd-party provider in v2 is a 1-file PR.
2. **Structured logging everywhere.** All review events, provider calls, agreement decisions, sweeper actions emit structured JSON logs (schema-versioned). Substrate for all three flywheels.
3. **Cryptographic provenance on receipts.** Every finding's SHA receipt is signable. Makes v2 marketplace possible (providers prove work; customers prove payment; data contributors prove tuples).

---

## 12. Honest-report principle

**Load-bearing for team culture, not optional.**

- Every verdict file states **GREEN / YELLOW / RED** unambiguously, never spun
- If data is bad, the verdict is RED, regardless of how much was invested
- Autopilot missions STOP on RED rather than autonomously pivot
- The receipts counter is real — every entry has a verifiable SHA
- Customer-visible metrics (precision, recall, agreement rates) are computed from real data, not marketing approximation

**Violation of this principle is a more serious problem than a missed feature.** The trust artifact only works if it's actually trustworthy.

Week 1's WEEK1-VERDICT.md is the template: RED stated unambiguously, alternative (majority mode) surfaced honestly, structural reason (DeepSeek as veto) explained, no autonomous pivot. Every verdict file from now on follows this pattern.

---

## 13. Strategic forks (open questions)

These will be answered by data over months, not declared now:

1. **Unanimous-on-2 vs majority-on-3+.** v1 ships unanimous-on-2. v2 might revisit if more providers prove useful. The "agreement" brand may need to evolve.

2. **Marketplace-as-voter vs marketplace-as-router.** Current model is "N providers vote on each finding." Data may show "different providers excel at different bug categories" → pivot to routing-by-task-type. Decision gate: month 6–9 with accumulated real-repo data.

3. **Auto-PR / Patch Bot trigger.** When is write permission earned? Tentative threshold: ≥60% of suggested-patch v1.5 findings accepted within 30 days. May need adjustment.

4. **Specialist member ordering.** Security vs perf vs ops vs frontend first? Driven by customer pull in Phase 2.

5. **AntSeed integration depth.** Currently invisible. May surface for crypto-native customers as opt-in payment rail. Branding stays separate.

6. **Own a fine-tuned auditor model (year 2+)?** Once data corpus is large enough, fine-tuning Llama/Qwen on (bug, accepted-fix) pairs becomes feasible. Decision: only if the fine-tune demonstrably beats frontier models on customer data. Until then, route + eval, don't train.

---

## 14. Tech stack

| Layer | Choice |
|---|---|
| Frontend / API | Next.js 16 (App Router) on Vercel |
| Database | Postgres via Vercel Marketplace (Neon) |
| Components | shadcn/ui + Tailwind |
| Auth | GitHub App OAuth (no external auth provider needed for v1) |
| Email | Resend or Postmark (transactional only; digests deferred to v1.5) |
| Hosting | Vercel (frontend + API), Neon (DB), GitHub App (webhook origin) |
| Provider SDKs | `@anthropic-ai/sdk`, `openai` npm package |
| Test | vitest (inherited from clawpatch fork) |
| Lint / format | oxlint + oxfmt (inherited) |
| Package manager | pnpm (lockfile-locked) |

---

## 15. Brand and positioning

**AntFleet** is the b2b product + marketplace brand. One word, capital-A capital-F. Aesthetic: Stripe + Linear (clean, numerical, receipts-forward, sans-serif, generous whitespace, monospace only for code blocks and SHAs). Voice: direct, technical, trustworthy. No marketing fluff.

**Pitch (locked Phase 0, 2026-05-16):** "Two independent frontier models on every PR. We post only what both flag — and across 6 real-repo runs, zero hallucinated findings. Fewer-but-real bugs you wouldn't have written up yourself, each one pinned to a closing SHA." Do NOT pitch coverage or "we catch the bugs you knew about" — V2 + V3 data refuted that framing. Precision + receipts is the story.

**Antfeed** is the community / consumer brand — Colony Scout persona on X / Farcaster (lowercase, third-person, daily snapshots, no emojis, bare arrow CTAs). Discovery and social proof for the AntSeed ecosystem. Sibling brand to AntFleet, not parent or child.

**AntSeed** is the protocol layer. Not in AntFleet product surface. Not in landing page. Not in customer copy. Only in deep technical pages for crypto-native buyers (`/architecture` or `/marketplace/under-the-hood`).

**The three names are a family**, not a hierarchy: AntSeed (protocol) + Antfeed (community) + AntFleet (product). All share the "Ant" prefix as a brand signature. None is renamed or retired — they're three coordinated faces of the ecosystem.

**Don't position against** Cursor, Devin, Snyk, CodeRabbit, Greptile, or any competitor by name. Position against the *absence* of trust infrastructure for autonomous code. "We're the first X" is a stronger frame than "we're a better Y."

---

## 16. Relationship to other projects

**antseed-agent** (`~/antseed-agent`): Independent project. OSS contributor agent for the AntSeed protocol. Source of:

- The slice-scoped audit pattern
- The `gate.sh` recipe contract
- The sweeper-with-SHA-receipts pattern (which Fleet's sweeper inherits)
- The 11+ gated bugs that serve as ground-truth corpus for Phase 0 sanity check
- The contribution-batch hypothesis pattern (every batch carries an explicit acceptance prediction)
- The CONTRIBUTIONS.md ledger pattern
- The "honest empty result" discipline (when there's no signal, file zero findings, don't force findings)

Not a Fleet customer. Not a Fleet feature. The upstream R&D lab that produced patterns Fleet adopts.

**clawpatch** (https://github.com/openclaw/clawpatch): MIT-licensed OSS auditor. Fleet's fork base. Acknowledged in `LICENSE`, `UPSTREAM.md`, and `ARCHITECTURE.md`. Treat as inspiration source, not upstream — Fleet diverges at commit `b03bf52` and never tracks upstream after fork point.

**OpenClaw** (the team behind clawpatch): direct competitor in the same space. Watch publicly; don't contribute upstream; don't market against by name.

---

## 17. Where to start a new session

If you're a fresh Claude session reading this for the first time:

1. **Read this file** (you just did)
2. **Read `ARCHITECTURE.md`** for technical surfaces and what's inherited from clawpatch
3. **Read `examples/dogfood-results/WEEK1-VERDICT.md`** for the Week 1 empirical verdict
4. **Read `examples/antseed-corpus-results/WEEK1-VERDICT-V2.md`** and **`WEEK1-VERDICT-V3.md`** for the Phase 0 real-repo verdicts
5. **Check `git log --oneline -20`** for recent commits
6. **Check `.env.local`** exists with `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (gitignored; never log contents)

Then route to the active phase:

| State | Next action |
|---|---|
| Phase 0 not yet run | Ask the user to run the Phase 0 autopilot mission |
| Phase 0 GREEN | Proceed to Phase 1, Mission 1 (GitHub App skeleton) |
| Phase 0 YELLOW | Tune prompts or slicer before Phase 1 |
| Phase 0 RED, strategy not yet settled | Strategy conversation, no more code |
| **Phase 0 RED, pitch (b) locked (current state)** | **Proceed to Phase 1, Mission 1 — the precision-not-coverage pitch absorbs RED honestly** |
| Phase 1 in progress | Resume the active mission per `.fleet/mission-state.md` (if it exists) |
| Phase 2+ | Read latest weekly metrics report in `state/metrics/` |

---

## 18. Things to never lose

If this file is ever rewritten or replaced, these specific points must survive verbatim:

0. **The brand family is AntSeed + Antfeed + AntFleet, in that order of layering.** AntSeed = protocol (external). Antfeed = community/social brand. AntFleet = product + marketplace. One word, capital-A capital-F for AntFleet. Don't reintroduce "Antfeed Fleet" or other two-word variants — that name is retired.

1. **DeepSeek/OpenRouter dropped from default for empirical reasons** — not because the marketplace thesis failed, but because price-stratified diversity isn't capability diversity on this corpus. The marketplace thesis remains live; the implementation just needs peer-tier providers.

2. **Receipts are the moat, not agreement.** Agreement is the quality gate. Receipts are the public, verifiable, growing-counter trust artifact. Customers can copy "we use multiple LLMs"; they can't copy a year of SHA-pinned closure receipts.

3. **AntSeed is invisible in product surface.** Even if the marketplace underneath uses it. Two-step sells lose deals.

4. **Honest-report principle.** RED is the right answer when the data says so. The trust artifact must be actually trustworthy. Spin once, lose the moat forever.

5. **The marketplace is the endgame, not the start.** Earn the right to open it by first proving the auditor produces real outcomes.

6. **Data capture from day 1 — analysis later.** The MVP captures the substrate; v1.5 builds the eval/routing intelligence on top. Lost early data cannot be reconstructed.

7. **No CLI, no IDE, no in-editor anything.** PR webhook + comment + receipts page is the entire surface for v1. Editors are sticky-UX moats owned by entrenched players.

8. **Don't take builder-shaped design partners** ("write me a feature") until Phase 4 earliest. They distort the roadmap toward UX you can't win.

9. **Pitch is (b): precision, not coverage.** V2 + V3 Phase 0 verdicts (6 runs of real-repo data) settled this. Two frontier models in unanimous mode catch *fewer* of a curated bug list than either model alone — that is the truth — but *what they agree on is real ~100% of the time*. The product promise is "fewer-but-real bugs you wouldn't have written up yourself," not "we catch the bugs you already knew about." Anyone tempted to revert the pitch to coverage-language should re-read `examples/antseed-corpus-results/WEEK1-VERDICT-V3.md` first.

---

*This file is the canonical strategy substrate. Update it when locked decisions change. Don't update it for in-flight experiments — those live in verdict files and run reports.*
