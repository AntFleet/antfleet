# Patch Agent v1.5 — one-page implementation plan

Spec path: this prompt. Branches: `feat/patch-agent-v15-pr{N}-*` off `main`,
one per deliverable (1 → 7), each independently mergeable behind the env flag.

## Notes from exploration

- Actual provider files are `src/providers/anthropic.ts` + `src/providers/openai.ts`
  (shared `@antfleet/cli` package). Spec said `src/providers/...`, that matches.
- Existing agreement gate lives at `src/providers/agreement.ts` (NOT `src/agreement/*`).
  New patch gate will live alongside as `src/providers/patch-gate.ts` for symmetry.
- Review orchestrator: `apps/web/lib/review-pipeline.ts` (`reviewPR`) → returns
  `ReviewBundle` to `apps/web/lib/review-worker.ts` (`processClaimedRow`) which
  posts the comment via `apps/web/lib/pr-comment.ts` (`formatPRComment`).
- Sweep orchestrator: `apps/web/lib/sweep.ts` (`runSweep`) called from
  `apps/web/app/api/cron/sweep/route.ts`. Closure detection: `apps/web/lib/sweeper.ts`.
- `ChangedFile` (`apps/web/lib/github-files.ts`) already fetches the unified
  diff per file from `listFiles`, but only retains the `patch` for the oversize
  fallback path. For the diff-hunk filter, we need to retain `patch` for every file.
- Onboarder event types are text, application-validated. New types `patch_proposed`
  and `patch_accepted` need no migration.
- Migration index next: `0019` (last applied: `0018_paywall_channels.sql`).

## Open-question defaults (no-stop directive)

1. Unanimous patch = "both providers returned non-null for same findingId, ship Opus's" — accept.
2. 20-line cap per finding — accept.
3. `publicReceipt` governs patch visibility (no new flag) — accept.
4. Canary install — first install with `patchAgentEnabled=true` flipped manually; default off in prod.

## Existing files to touch

| File                                          | Change                                                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/db/schema.ts`                       | add fields to `findingStatus` + `reviews` + `installations`                                                                            |
| `apps/web/db/migrations/0019_patch_agent.sql` | NEW migration                                                                                                                          |
| `apps/web/db/queries.ts`                      | extend `recordFindingStatuses`, add `recordPatchProposal`, `recordPatchAccepted`, `loadPatchAcceptanceWork`; wallet aggregator updates |
| `apps/web/lib/github-files.ts`                | retain `patch?: string \| null` on every `ChangedFile`                                                                                 |
| `apps/web/lib/review-pipeline.ts`             | thread `patches` into `ReviewBundle` when flag enabled                                                                                 |
| `apps/web/lib/review-worker.ts`               | wire patch generation between agreement gate and comment post; persist proposals                                                       |
| `apps/web/lib/pr-comment.ts`                  | add suggestion block sub-section; conditional footer line; closure receipt unchanged                                                   |
| `apps/web/lib/sweep.ts`                       | add `runPatchAcceptancePass` (NEW pass), reuses existing octokit + payment of pattern                                                  |
| `apps/web/lib/onboarder.ts`                   | add `patch_proposed` / `patch_accepted` events; 7-day aggregator now reports `patchesProposed`/`patchesAccepted`                       |
| `apps/web/lib/paywall/queries.ts`             | add `patchesProposed` + `patchesAccepted` counters to `WalletReputation`                                                               |
| `apps/web/app/wallets/[address]/page.tsx`     | render "Patches accepted" stat next to close rate                                                                                      |
| `src/providers/anthropic.ts`                  | add `proposePatch(...)` second-call method (no breakage to existing `review`/`fix`)                                                    |
| `src/providers/openai.ts`                     | same                                                                                                                                   |
| `src/provider.ts`                             | extend `Provider` interface (optional method) + ship JSON schema `patchSuggestionJsonSchema`                                           |
| `src/types.ts`                                | add `PatchSuggestionOutput` zod schema                                                                                                 |

## New files to add

| File                                    | Purpose                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/providers/patch-gate.ts`           | patch agreement: both non-null per findingId → ship Opus's                                                                                 |
| `src/providers/patch-gate.test.ts`      | 4-case agreement matrix + idempotency                                                                                                      |
| `apps/web/lib/patch-generation.ts`      | per-review fan-out: takes agreed findings + ChangedFile patches, returns `PatchProposal[]` with skip reasons                               |
| `apps/web/lib/patch-generation.test.ts` | size cap, outside-hunk filter, timeout, idempotency                                                                                        |
| `apps/web/lib/patch-acceptance.ts`      | sweeper-side detection: fetch file at HEAD, match suggestion against current content                                                       |
| `apps/web/lib/patch-acceptance.test.ts` | whitespace tolerance, no false positive on unrelated changes                                                                               |
| `apps/web/lib/diff-hunks.ts`            | parse `f.patch` into `{ path, hunkRanges: [{ start, end }] }`; check whether `(startLine, endLine)` of finding evidence lies inside a hunk |
| `apps/web/lib/diff-hunks.test.ts`       | 4 cases: in-hunk / out / no-startLine / binary (no patch)                                                                                  |
| `apps/web/lib/pr-comment-patch.test.ts` | byte-identical regression test fixture (flag=off) + patch-included render                                                                  |
| `.omc/plans/patch-agent-v15-plan.md`    | this file                                                                                                                                  |

## Deliverable order (one PR each)

1. **Schema migration** — `0019_patch_agent.sql` + `schema.ts` + `queries.ts` extensions + types. No behavior change.
2. **Patch generation per-provider** — providers gain `proposePatch`, web app adds `patch-generation.ts` (gated by `PATCH_AGENT_ENABLED`; default false → no-op).
3. **Patch agreement gate** — `src/providers/patch-gate.ts` + tests.
4. **Comment rendering** — `pr-comment.ts` extension; suggestion sub-section + conditional footer. Regression test fixture.
5. **Sweeper patch-acceptance pass** — `runPatchAcceptancePass`, `patch-acceptance.ts`, comment receipt.
6. **Feature flag + per-install override** — `installations.patchAgentEnabled`, env precedence, defaulted off in prod.
7. **Onboarder + receipts** — new event types, 7-day aggregator update, wallet stat.

## Non-break invariants — test mapping

| Invariant                             | Test                                             |
| ------------------------------------- | ------------------------------------------------ |
| Flag=off byte-identical               | `pr-comment-patch.test.ts` snapshot              |
| Generation failure → findings-only    | `patch-generation.test.ts` timeout branch        |
| One-side propose → findings-only      | `patch-gate.test.ts` only-Opus + only-GPT        |
| Drawdown stays 1 per review           | new test in `review-worker.test.ts`              |
| Sweeper retains evidence-file closure | `sweep.test.ts` existing tests must keep passing |
| Idempotent regeneration               | `patch-generation.test.ts` re-run                |
| Public receipt governs visibility     | `wallets/[address]` query filter test            |
| Comment header unchanged for sweeper  | `pr-comment.test.ts` `Review {id8}` regex        |

## Verification per PR

- PR1: `pnpm --filter @antfleet/web db:generate` produces clean snapshot; `pnpm --filter @antfleet/web typecheck`; `pnpm --filter @antfleet/web test`.
- PR2: `pnpm test` at root + web app; spot-check via the existing recorded-response tests in `src/providers/*.test.ts`.
- PR3: pure-fn tests at root.
- PR4: snapshot fixture + render tests; flag-off branch reproduces existing fixture byte-for-byte.
- PR5: integration tests for `runPatchAcceptancePass` with mocked octokit.
- PR6: `decideGate` + worker tests with flag toggle matrix.
- PR7: onboarder + wallet aggregator tests.

Final: `pnpm typecheck` and `pnpm test` clean on every PR before merge.
After each merge: `vercel ls --prod` (per memory rule).
