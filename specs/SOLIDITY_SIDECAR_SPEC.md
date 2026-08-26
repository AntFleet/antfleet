# SPEC: Whole-contract Solidity finder sidecar (cross-file fund-extraction finder)

Status: READY TO BUILD · 2026-08-26 · supersedes the stale builder handoff
`src/sidecar-solidity/BUILD_PROMPT.md`. This is the buildable, sidecar-scoped
refinement of `specs/SOLIDITY_AUDIT_MODE_SPEC.md` §3. A builder should be able to
implement from this document without asking a clarifying question, and should be
structurally unable to touch the PR-diff reviewer or rebuild the kill-test.

---

## §0 Load-bearing constraint — SIDECAR, NOT A FORK

Non-negotiable:

- **Zero changes to the PR-diff reviewer.** The production finding path lives at
  `apps/web/lib/review-worker*.ts`, `apps/web/lib/review-pipeline.ts` and its
  chunking helpers. None of them may be imported by, modified by, or regressed by
  this sidecar. Acceptance criterion: `git diff --stat` on the branch touches
  only `src/sidecar-solidity/**`, `scripts/audit-solidity.ts`, `package.json`
  (one script line), and docs. "No regression to the PR reviewer" is an
  acceptance criterion, not a preference.
- **Reuse the finding contract already defined in
  `src/sidecar-solidity/killtest.ts`:** `auditFindingSchema` / `auditOutputSchema`
  as the model-output schema (lenient-parse philosophy, see the `#134` notes in
  `src/types.ts`), `scoreAuditFinding` as the scorer, `matchesBug` /
  `observedSeverityFor` semantics where localization matters. Do NOT invent a new
  finding shape or a parallel scoring rubric.
- **Reuse `src/sidecar-solidity/model-client.ts` as the only model transport.**
  It exists precisely because registered providers' `.review()` force-parse the
  strict PR-review shape. Extend it there if needed (e.g. an injectable caller
  for tests); never hand-roll a second HTTP client and never route through
  `provider.review()`.
- **Finding-phase only.** No verification, no PoC execution, no submission, no
  `reproduced` verdicts. The parked Foundry lane (`parked/foundry-mode-b`,
  verdict audited as unsound) stays parked and is not referenced as a dependency.
- **Privacy.** Any bounty-target usage stays private: no public receipts, posts,
  PRs, or disclosures about target repos. Submitting anything to any platform is
  a human action this code never performs.
- **Cost discipline.** Metered credits are out. Dry-run is the DEFAULT mode;
  tests use mocked/injected model calls; real invocation requires an explicit
  `--live` flag plus a key present in the environment. No Neon branches, no DB.

## §1 Falsifiable premise

The PR-diff reviewer is structurally blind to **cross-file Solidity bugs**: when
the vulnerable logic lives in a sibling/base/factory/library contract rather than
the reviewed file's diff, no amount of model quality recovers it — the evidence
isn't in context. This sidecar ships value **if and only if** whole-closure
context finds cross-file unprivileged fund-extraction/freeze bugs that the
single-file path structurally cannot see, while remaining no worse than the
single-file path on inline bugs. It would be proven false if cross-file catches
in practice turn out to require something other than closure context (e.g. more
targets, better steering) or if closure-context noise degrades inline-bug recall.

Evidence standing behind this premise (recorded, not re-opened):
`solidity-killtest/RESULT.md` — clean matched-objective re-run on Code4rena
2023-01 Biconomy H-03: slice arm (entry file only) structurally MISSED the
factory-salt bug; audit arm (entry + closure) CAUGHT it at CRITICAL,
synthesizing across both files. On single-file targets (redacted-cartel,
popcorn, stakehouse) closure added NO uplift. N=1 cross-file target: mechanism
demonstrated, statistics not.

## §2 Scope & non-goals

**In scope:** one thing — given an entry contract set in a checked-out Solidity
repo, assemble the whole-contract dependency closure, run a neutral
fund-extraction finder over it, and emit program-rule-scored PURSUE/DROP
findings with file+line evidence. Cross-file/cross-contract bug classes are the
target: accounting across contracts, factory/instance trust (deployment-salt /
init-order), proxy/implementation splits, module interactions.

**Non-goals (explicit):**

1. The PR-diff reviewer and every JS/non-Solidity flow (§0).
2. The Foundry PoC / verification lane — stays parked.
3. Another prove-the-premise labeled kill-test. The kill-test measured recall on
   solved bugs; it cannot measure novel-bug finding. It ran; its lesson is
   encoded here. Nobody rebuilds it as part of this work.
4. Auto-submission, auto-publication, auto-verification of anything.
5. Any specific bounty target (incl. Puffer) as a feature or fixture. Targets
   are operator-supplied inputs at runtime.
6. General-uplift claims: on single-file inline bugs this sidecar adds nothing
   over what exists. Its README must say so.

## §3 Components

### A. Dependency-closure context assembler (`closure.ts`)

Input: repo root + entry contract path(s) + byte/token budget (default 400_000
chars ≈ ~100k tokens; flag-overridable).

Resolution — BOTH directions:

- **Forward:** transitive `import ... "X.sol"` from each entry (relative paths,
  plus remappings below). Libraries, bases, interfaces arrive through this.
- **Reverse:** build an index of, for every `.sol` file in the tree, the
  contract names it defines and the import specifiers it declares; then include
  any file that imports an entry file OR connects to an entry-defined symbol,
  where "connects" means ANY of: word-bounded usage (`new X(`, `X(` casts,
  `is X`), COMPOUND-WORD embedding (`SmartAccountFactory`,
  `SmartAccountCreated` — symbol followed by `[A-Z_]`), or the file's own
  basename containing the symbol (`SmartAccountFactory.sol`). Compound rules
  exist because real factories often never type the wallet symbol directly
  (verified against the biconomy fixture). This captures factory↔instance
  pairs: `SmartAccount.sol` never imports `SmartAccountFactory.sol`; the
  factory reaches the wallet only backwards.
  Reverse hits JOIN THE FRONTIER: their own forward imports are resolved and
  included transitively under the same budget policy (a factory typically drags
  in interface/base files the finder needs).
  Acceptance anchor: from the `biconomy-counterfactual` fixture's
  `SmartAccount.sol` entry, the assembler MUST pull `SmartAccountFactory.sol`
  into the same context (unit-tested; see §5).
- **Remappings:** parse `remappings.txt` lines (`a=b`) and `foundry.toml`
  `[profile.default]` `remappings = [...]` if present; map bare specifiers by
  longest-prefix match into the tree. Without them, resolve relatives only and
  RECORD unresolved externals in the output rather than failing or silently
  dropping (an incomplete closure must be visible to the operator and stated in
  the report header).

Output: `{ includedFiles, externalUnresolved, bytes, truncated }` plus the
assembled ordered file blocks. Ordering = eviction order inverted:

1. Entry contracts (always kept)
2. Direct forward deps of entries + direct reverse referencers (factories)
3. Transitive forward closure, BFS from entries (bases before children)
4. Remaining reverse-only references (furthest first)

When the budget is exceeded, evict from the END of this order (never truncate a
kept file mid-content — line numbers must survive) and set `truncated: true`
with the evicted list recorded. If the ENTRY set ALONE exceeds the budget, keep
the entries whole anyway (an audit without its entry is worthless), mark
`truncated`, and print an explicit warning naming the overflow. Documented,
deterministic, unit-tested.

### B. Fund-extraction finder call (`prompt.ts` + `model-client.ts`)

One finder call per assembled closure (per entry set). Objective text is
NEUTRAL and target-agnostic: enumerate every way an unprivileged actor can
extract funds or permanently freeze them — across deployment, initialization,
authorization/signature checks, accounting, and execution paths — with evidence
(file + line range) per finding, trigger role, and preconditions.

**Anti-contamination rule (hard):** the prompt must not name, hint at, or
structurally describe any specific vulnerability, attack chain, or known
finding for the target. Rationale: the first Biconomy re-run was invalidated by
exactly this over-steer (prompt described the H-03 answer; see RESULT.md).
Neutrality is enforced in review: no bug-class examples tied to the target's
code, no "consider whether salt includes…" phrasing. Generic category lists
(reentrancy, oracle misuse, access control — as already exist in
`buildSpikePrompt`'s supplement) are allowed; target-specific hints are not.
A unit test asserts the rendered prompt contains none of a small corpus of
target-derived strings; concretely, the committed closure fixture ships a
`hintStrings` list (phrases describing its known salt/init-style bug) and the
test asserts none appear in the rendered prompt.

Parse with `auditOutputSchema`. No retry-on-empty loops beyond the model
client's built-in retries.

### C. Program-rule scoring (`killtest.ts` — reused, unchanged)

Every parsed finding passes through `scoreAuditFinding` against operator-supplied
program rules text (severity definitions, scope exclusions, the ~1-hour
measures/recovery damage cap, duplicate-of-known): DROP privileged-only,
recoverable-under-cap, out-of-scope, or duplicate findings WITH reasons; PURSUE
only all-four-pass findings. Output block per run:

```
{ findings: [...], scored: [{title, verdict, reason}], droppedCount, pursueCount }
```

The four-factor schema and thresholds live in `killtest.ts` and are imported,
never forked. If scoring needs a tweak later, it happens there or nowhere.

## §4 CLI / interface

```
pnpm audit-solidity --target <dir> --entry <repo-relative .sol path>
                    [--entry <more paths>...] --rules <file.md>
                    [--budget <bytes>] [--out <report.json>] [--live]
```

- Default is **DRY-RUN**: assemble closure, render the prompt, print closure
  stats (files kept/evicted/unresolved, bytes vs budget) and the full prompt to
  stdout/the report file. NO model call, no API key required.
- `--live` performs the single finder call through `model-client.ts` using its
  existing default model (`AUDIT_DEFAULT_MODEL`), scores results, writes JSON +
  human-readable report to `--out`.
- Exit codes: 0 success (including zero findings); 2 usage errors; nonzero on
  assembly failure (e.g. missing entry file).
- No DB, no daemon, no webhook. One shot, one report.

## §5 Acceptance criteria & tests

1. `tsc` clean; `pnpm vitest run src/sidecar-solidity` green — existing 44
   killtest/context/prompt tests untouched and passing, plus new coverage:
   - Closure assembler: committed inline fixture mirrors the Biconomy shape
     (wallet imports bases; separate factory file creates wallet, imports it
     back-referenced only by symbol usage) — from the wallet entry, BOTH wallet
     and factory land in one context; eviction order holds under a tiny budget;
     unresolved externals reported, never thrown away silently.
   - Optional integration test against the real
     `solidity-killtest/targets/biconomy-counterfactual/scw-contracts/**`
     checkout: runs when present, `skipIf`-guarded otherwise (that tree is
     gitignored).
   - Anti-contamination: rendered prompt contains zero target-derived hint
     strings from the fixture.
   - A→B→C wiring with an INJECTED fake model call (no network): dry-run emits
     no calls; `--live` path parses, scores, and drops a privileged-only
     finding with its reason end-to-end.
2. `git diff --stat` touches only `src/sidecar-solidity/**`,
   `scripts/audit-solidity.ts`, `package.json`, docs/spec files (§0).
3. Dry-run works end-to-end with zero credentials on the Biconomy fixture.
4. README in `src/sidecar-solidity/` states honestly: finds cross-file bugs the
   diff reviewer structurally misses; finding-phase only (no verification, no
   submission); conditional value on cross-file classes, no general uplift;
   N=1 mechanism evidence.

## §6 Risks & honest limits

- **Conditional value.** Single-file inline bugs: no uplift over the existing
  path (measured). Cross-file classes: mechanism shown once, cleanly (N=1).
  Statistical confidence needs more cross-file targets under the same
  matched-neutral protocol; until then, claims stay at "demonstrated."
- **Closure bounding can evict a relevant file.** Mitigation: deterministic
  eviction order weighted toward entries + direct neighbors + factories; the
  evicted list is printed so a miss can be traced to bounding vs blindness.
  Budget is operator-adjustable per run.
- **Reverse-reference heuristics can over-include** (name collisions pull
  unrelated files). Mitigation: reverse inclusion triggers only on
  contract-symbol usage patterns, bounded by the same budget/eviction policy;
  over-inclusion costs tokens, not correctness.
- **The finder still misses and hallucinates.** Output is unverified candidate
  findings with self-reported factors; `scoreAuditFinding` filters slop but
  proves nothing true. Everything is finding-phase; humans verify, decide, and
  submit. Never forget the redacted-cartel integrity catch: labels and outputs
  get read, never blindly trusted.
