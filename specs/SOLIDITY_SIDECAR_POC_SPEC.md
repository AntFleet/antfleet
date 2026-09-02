# Solidity sidecar — PoC generation + local-container verification (post-PURSUE)

Status: UNDER RE-AUDIT (two-tier redesign) — the single-tier v8 had converged to zero C/H/M
over eight rounds, but the 2026-09-02 reversal that admits the harness/callback class
(`POC_EXECUTED`, Tier 2) re-opened the soundness surface. A fresh 5-lane audit round flagged
the trace-scoping and spike-yield holes now fixed in this revision; **re-running all five
lanes until 0 C/H/M before the gates are rebuilt.** Phase-1 code still implements the
single-tier model. · implements
[issue #179](https://github.com/AntFleet/antfleet/issues/179) (closure is a **Phase-3**
outcome — see §7) · extends `specs/SOLIDITY_SIDECAR_SPEC.md` and
`specs/SOLIDITY_SIDECAR_PHASE0_SPEC.md`.

## Problem

The finder stops at **PURSUE** = "survived citation-grounding (`scoring.ts`) + one
adversarial refuter (`refuter.ts`)" — not "confirmed exploitable." A downstream
consumer (bounty triage, maintainer, merge gate) must redo the confirmation work and
cannot tell a true PURSUE from a plausible-but-wrong one. Live ROI (der-sc @`59e724b`;
`antfleet-sidecar-der-sc-eval-vs-manual`): a **human-authored** 2-assertion
**local-deploy** Foundry PoC (deploys the contract from source, no live fork) turned
the hedged headline "likely" into "proven" for H1/H2/M1. That the motivating PoC was
human-, not model-, authored is why §7's generation spike GATES the executor build.

**der-sc IS the eligible worked example — the motivating target, not an excluded one.**
#179 was **born from** der-sc: the antfleet der-sc eval (`antfleet-sidecar-der-sc-eval-vs-manual`)
ran the source-only finder, then a human hand-authored `test/AuditPoC.t.sol` over 7
write→`forge test` cycles to `4 passed; 0 failed`, and the same session's closing
instruction — *"open issue that product sidecar solidity lacks feature that covers this"* —
**is issue #179**. That PoC (re-run 2026-08-29, `4/4 PASS`) is `contract AuditPoC is Test,
Deployers` with a `PoolManager` harness and `MockERC20` currencies, yet it is **sound**: it
deploys the **real** `RelativeIndexHook` from source, drives it through a real v4
`PoolManager`, and asserts on the real hook's reverts/state. The `Deployers`/`MockERC20`/
`HookMiner` scaffolding is **benign** — standard, vendored Uniswap/solmate test utilities that
do **not** inject the bug (the inverted epoch-cap and dead-band live entirely in the real
hook). An earlier revision wrongly excluded der-sc by conflating **fabrication** (an
attacker-settable mock that *injects* the asserted state → hollow CONFIRMED) with **benign
vendored scaffolding**. The §3.3 gates therefore admit harness scaffolding by a **real-
dependency anchor** (§3.3.A): the deployed-and-asserted **target** must still be the real
cited contract (build-info ground truth), but *other* instantiated contracts are allowed iff
they resolve by a known import specifier **and** to a real-dependency root (`lib/` /
`node_modules/`), never the repo's own `src/`/`test/`/`script/`. This admits the der-sc class
(v4 hooks, and any single-target bug whose proof needs vendored fixtures) while the fabrication
surface stays closed. Doing so re-opens an audited surface across four gate dimensions
(base allowlist, multi-contract, substituted-dependency, revert-assertion), so it carries a
fresh 5-lane spec + 3-lane impl audit before it lands (§7).

## Goal

An **optional, strictly post-PURSUE** stage that (1) **generates** a minimal
local-deploy Foundry test targeting the cited lines, driven by
`triggerRole`/`preconditions`; (2) **executes** it in a local Docker `--network none`
sandbox (a separate driver, never the patch-verifier runner); (3) promotes to one of two
new terminal states only when the PoC executes under the §3.3/§3.4 gates — **`CONFIRMED`**
(strong: direct-drive, statically bound) or the explicitly weaker **`POC_EXECUTED`**
(harness-driven, trace-observed; §1) — otherwise the finding **stays PURSUE with a reason**
(never demoted to DROP).

**#179 acceptance, in consumer terms (what Phase 3 closes and what it does not).** The
issue's pain is that the consumer must redo confirmation and cannot tell a true PURSUE
from a plausible-but-wrong one. This stage's Phase-3 deliverable is: *for an eligible
finding, an executed, deploy-verified (build-info ground-truth), human-reviewable PoC and a
terminal state — `CONFIRMED` for the direct-drive class, `POC_EXECUTED` for the harness/callback
class (der-sc) — that removes the LABOR of writing and running the scaffold.* It deliberately
does **not** remove the consumer's relevance judgment (§1 leaves "does this assertion capture
THIS bug" to the human, and for `POC_EXECUTED` also "was the target driven through the cited
path"), and it applies only to the eligible classes (§2). #179 is therefore re-scoped from
"confirm exploitability" to "produce a human-reviewable executed+deploy-verified PoC and a
tiered terminal state for the eligible local-deploy classes"; closing it requires stating
this re-scope on the Phase-3 PR, not implying trust-without-review.

## §0 Load-bearing constraints

- **Strictly post-PURSUE.** Runs only on PURSUE findings; never re-opens DROP.
- **Opt-in / inert by default.** `--poc` enables generation; `SIDECAR_POC_EXEC=1`
  enables execution; both OFF. `--poc` honored only with `--live` (dry-run ignores it,
  stderr warning; dry-run never spends). A `--live` run without `--poc` is
  **byte-identical to today** (§3.1 + §5.1 exact-bytes fixture, incl. the sweep
  `...result` JSON path). Execution additionally requires a valid Phase-2 GO artifact
  (§7) — `SIDECAR_POC_EXEC` refuses to run without it.
- **Un-parks the Foundry lane as a VERIFICATION stage only.** Does not resurrect the
  patch-verifier `reproduced` verdict; **must not import/reuse `apps/web` code**
  (`isSafeReproPath` etc. are reimplemented locally; acceptance check: zero
  `apps/web/**` imports from `src/sidecar-solidity/**`).
- **No auto-submission, ever.** `CONFIRMED` and `POC_EXECUTED` are local, human-gated.
- **Cost discipline.** Generation uses `model-client.ts`; no new HTTP client; no Neon
  branch; no DB. One new dependency permitted: a Solidity parser
  (`@solidity-parser/parser`) for the AST gates.
- **Sidecar boundary.** `git diff --stat` touches only `src/sidecar-solidity/**`,
  `package.json`, spec/docs.

## §1 The soundness ceiling (the label states it verbatim)

Prior Foundry-execution builds were rejected **twice** for minting a **hollow** verdict.
The standing DECISION (`antfleet-foundry-lane-descope-spike-gate`) we adopt is a **two-tier**
outcome — a strong tier that keeps the original static-bound guarantee, and a distinct,
*explicitly weaker* tier for harness-driven PoCs (der-sc) whose target is driven indirectly.
The two states are separate on purpose so a consumer cannot read the weaker one as the
stronger; the name carries the difference.

> **Tier 1 — `CONFIRMED` (strong, static-bound): "a forge test that deploys the real cited
> contract from source (verified by forge build-info), makes a non-static call **directly**
> to it (the DRIVE), and then executes an assertion that reads that same target instance
> after the drive."** HUMAN-GATED, run-specific, NEVER auto-published. Not a claim of
> "provably THE exploit."
>
> **Tier 2 — `POC_EXECUTED` (weaker, harness-driven): "a passing forge test that deploys the
> real cited contract from source (same build-info ground truth) surrounded only by
> real-dependency-anchored allowlisted scaffolding (§3.3.A), whose `-vvvv` execution trace
> shows a call frame at the deployed target's address — i.e. the target's real bytecode
> executed under the test **inside the `testAuditPoc()` drive subtree, not `setUp()`**."** The
> target may be driven **indirectly** (through allowlisted harness such as `Deployers.swap` →
> real `PoolManager` → hook callback), and the assertion is **either** a post-drive target read
> **or** a `vm.expectRevert`-guarded drive (a bound assertion). **Proof-by-absence-of-revert
> does NOT earn `POC_EXECUTED`** — such a PoC stays PURSUE with the PoC attached (§3.3.B B4).
> HUMAN-GATED, run-specific, NEVER auto-published, and — because the trace proof IS the
> guarantee — **only reachable with execution (a Phase-3 outcome; no generation-only
> `POC_EXECUTED`)**. It does **not** claim a direct-drive assertion over the target's own
> state, and is NOT a proof of the exploit.

**Mechanically enforced** (§3.3 AST gates + §3.4 build-info + runtime trace): the deployed
target's source path equals `pocTarget.path` (forge build-info ground truth — not a
re-derived TS resolver); no fabrication cheatcodes / no forge-std state-fabrication wrappers
/ no assembly / **no repo- or test-authored logic contract** in the test — the only contracts
instantiated are (a) the cited target from real source and (b) real-dependency-anchored
allowlisted scaffolding (§3.3.A: resolves by a known import specifier AND to a
`lib/`/`node_modules/` file; never a repo-authored `src/`/`test/`/`script/` contract);
imports symbol-allowlisted. **Tier 1 additionally** requires the straight-line/direct-drive/
post-drive-read gates (§3.3 gates 1,7,8); **Tier 2** relaxes those (setUp + helpers + control
flow in setup permitted, indirect drive permitted) but **substitutes the mandatory §3.4
runtime target-frame trace proof** — a `POC_EXECUTED` is refused if the trace does not show the
target's bytecode executing.
**NOT enforced, left to the human** (so §1 does not overclaim): (a) that the assertion
captures *this* finding's bug vs. a true-yet-irrelevant property; (b) differential proof
against a corrected baseline; (c) an obfuscated cheatcode-address the scanner missed; (d)
an arbitrary literal address used where a real dependency is expected; (e) a vendored
dependency under `lib/`/`node_modules/` that *itself* fabricates the asserted state — the
§3.3.A anchor allowlists by import specifier + real-dependency path, **not** by content
hash, so a doctored vendored "mock" is caught only by human review of the PoC's imports
(v1 accepts this residual risk; content-hash pinning is a future hardening); (f) **for
`POC_EXECUTED` specifically**, that the harness drove the target through the *cited* path (the
trace proves the target executed in the test-body drive subtree, not that it executed the
vulnerable branch). Every `CONFIRMED` **and** `POC_EXECUTED` object **always co-carries
`humanGated:true` + `runSpecific:true` + `tier` + `assertionForm` + the atomic tier label
string** in the **same serialized record** (not only in the human renderer — AntFleet's
product is JSON receipts, so the caveat travels with the data): a JSON consumer reading
`findings[].verdict` also sees `poc.label` and `poc.assertionForm` beside it. The
consumer-facing label is an atomic string per tier — Tier 1: *"CONFIRMED (PoC-executed,
human-review-required): deployed the real cited contract, drove it directly, an assertion over
its post-drive state passed — NOT a proof of the specific exploit."*; Tier 2: *"POC_EXECUTED
(harness-driven, human-review-required): a passing Foundry PoC deployed the real cited contract
from source and its bytecode executed in the test drive, but the target was driven indirectly
and/or the proof is a bound revert-assertion rather than a direct-drive state read — NOT a
direct-drive assertion and NOT a proof of the specific exploit."* **For a non-terminal PURSUE
that still carries a PoC** (a `tier-not-enabled-by-spike` finding, or a `no-revert-only`
finding), `poc.label` is a **non-terminal** string — e.g. *"PoC attached (tier-earned but not
enabled in this build / no-revert only): treated as PURSUE, for human review — NOT a terminal
verdict"* — and is **never** the `CONFIRMED`/`POC_EXECUTED` caveat string, so a JSON consumer
keying on `poc.label` cannot read a terminal-sounding label beside a `verdict:"PURSUE"`. There
is **no
programmatic consumer of `verdict` in v1** (no auto-submission); the spec REQUIRES any
future programmatic consumer (a merge gate) to treat **neither** `verdict==="CONFIRMED"`
**nor** `verdict==="POC_EXECUTED"` as exploitability except in conjunction with `humanGated`,
and to never collapse the two tiers into one bucket (`POC_EXECUTED` ranks strictly below
`CONFIRMED`) — acceptance lines pin both.

## §2 Scope & non-goals

**In scope:** local-deploy Foundry PoC generation + local-container execution + the
two-tier `CONFIRMED`/`POC_EXECUTED` gate, for PURSUE findings — a **single asserted target** (the real cited
contract, build-info-verified) optionally surrounded by **real-dependency-anchored
allowlisted scaffolding** (§3.3.A), which admits the der-sc/v4-hook class.

**Non-goals (explicit — each keeps the finding PURSUE with the stated reason):**

1. **Live-fork PoCs** — reason "requires live fork (out of PoC v1 scope)".
2. **Test-authored logic contracts in the assertion path** — a PoC may deploy the cited
   target and **real-dependency-anchored allowlisted scaffolding** (§3.3.A: `Deployers`,
   `MockERC20`, `HookMiner`, etc. — resolved by known import specifier AND under
   `lib/`/`node_modules/`), but must NOT define or deploy a **repo-/test-authored** logic
   contract (a bespoke attacker, a hand-written fake the target consumes). Reentrancy/
   callback/flash-loan PoCs that require a test-authored attacker are still out; reason
   "requires a test-authored contract (out of v1 scope)". (This is the narrowed successor
   to the former blanket multi-contract ban: vendored fixtures IN, author-fabricated logic
   OUT.)
3. **Repo/test-authored substituted dependencies** — a *mock the finding-author wrote* (or
   the sidecar synthesised) as a target dependency stays forbidden (fabrication surface).
   A **vendored, allowlisted** generic mock (`MockERC20`/OZ `ERC20Mock` under
   `lib/`/`node_modules/`) used as benign scaffolding is admitted by §3.3.A. Reason for the
   forbidden case: "requires a test-authored substituted dependency (out of v1 scope)".
4. **ERC20-balance-fabrication PoCs** — the only funding cheat allowlisted is ETH via
   `vm.deal(address,uint256)` (§3.3 gate 3); `deal(token,…)` writes a token balance slot
   (fabrication) and is forbidden, so a bug that only triggers once an actor holds a
   token balance is ineligible; reason "requires token-balance setup (out of v1 scope)".
   (A vendored `MockERC20.mint(...)` is a normal call on allowlisted scaffolding, not a
   `deal(token)` slot-write, and is permitted.)
5. **Signature-dependent PoCs** — `vm.sign` is not allowlisted, so signature-replay /
   nonce / permit bugs are ineligible; reason "requires signature setup (out of v1 scope)".
6. **Unbound revert demonstrations** — `vm.expectRevert` is admitted **only** as a
   revert-assertion immediately guarding a **drive**, and the drive it guards differs by tier:
   **Tier-1** requires the guarded call to be the statically bound direct target drive (§3.3
   gate 8); **Tier-2** requires it to be the harness drive in `testAuditPoc()` whose subtree
   the §3.4 trace shows entering the target (`targetFrameObserved`) — der-sc PoC2/PoC4 rely on
   this (the inverted-cap buy MUST revert, draining MUST brick). A selector is required when
   the finding cites a specific error. An `expectRevert` guarding anything other than such a
   drive (or a bare no-op) is ineligible; reason "requires an unbound revert demonstration
   (out of v1 scope)".
7. **Real repo-`src/` collaborator instantiation** — a bug whose repro legitimately requires
   deploying a *real, non-mock* collaborator from the repo's own `src/` (a Vault that takes a
   freshly-deployed real Strategy, not a vendored fixture) is ineligible on both tiers (§3.3.A
   permits only the target + vendored scaffolding). This is **fail-safe** (stays PURSUE, never
   a wrong verdict) and honestly labeled; reason "requires a repo-src dependency instantiation
   (out of v1 scope)". A future increment could admit a build-info-verified real-src
   collaborator, but it widens the assertion's dependency surface, so it is deferred.
8. **The patch/repro-verifier runner** (`apps/web/**`).
9. **Auto-submission / auto-publication / any bounty target as a fixture.**
10. **A GitHub-Actions execution backend** — the Docker executor sits behind a
    `PocExecutor` interface so Actions can replace it later with zero pipeline change.
11. **Finder/recall uplift** — this is a verification stage.

Non-goals 1–7 are the eligibility limiters — 1/4/5/7 exclude a class outright; 2/3/6 draw the
line *within* the harness tier (vendored-scaffolding-and-revert IN as `POC_EXECUTED`,
test-authored logic OUT). §4's report banner names them so a consumer never reads
absence-of-CONFIRMED/POC_EXECUTED as "checked and failed" for a class that was ineligible.

## §3 Data model & modules

### 3.1 New verdict + result fields (backward-compatible)

`ScoredFinding.verdict` extends to `"CONFIRMED" | "POC_EXECUTED" | "PURSUE" | "DROP"`; both
`CONFIRMED` (Tier 1, static-bound direct-drive) and `POC_EXECUTED` (Tier 2, harness-driven,
trace-observed) are reachable **only** from PURSUE, and each such record **always** carries
`poc.humanGated===true ∧ poc.runSpecific===true`. `poc.tier` ∈ `"static-bound" |
"harness-driven"` records which gate path minted it; `CONFIRMED` ⇒ `"static-bound"`,
`POC_EXECUTED` ⇒ `"harness-driven"`. All new fields are **optional and `undefined` when
`--poc` is off** (so `JSON.stringify` + the sweep `...result` spread omit them —
byte-identical, pinned by §5.1). `ScoredFinding.poc?` records `generated`, `rationale`,
`tier`, `label` (the atomic §1 tier caveat string — co-carried in the serialized record, not
only the renderer, so a JSON consumer of `verdict` gets the caveat beside it), `assertionForm`
∈ `"target-read" | "revert"` (terminal) or `"none"`/`"no-revert"` (non-terminal, PoC attached
but stays PURSUE), `target {path,symbol,kind:"contract",derivation}`, `binding` (§3.3
`PocBinding`; `undefined` for the harness path, which has no static drive/assert binding),
`testPath`, `testContents`, `staticGate {passed,reasons}`, `executed`, `execution
{ranTests,passedTests,failedTests,skippedTests,compiled,passed,exitCode,summary,reason,
deployedTargetPath, drove, targetFrameObserved}`, `humanGated`, `runSpecific`.
`targetFrameObserved` is the §3.4 trace proof that a call frame executed at the deployed
target's address **within the `testAuditPoc()` drive subtree** — **required truthy for
`POC_EXECUTED`**; the executor upholds `drove === true ⇒ targetFrameObserved === true` (Tier 1's
direct in-body drive is a fortiori an in-body target frame). `FinderRunResult` gains OPTIONAL
**canonically named** counters (aligned with the sweep totals, so "got the verdict" is never
confused with "was run"): `confirmedVerdictCount?`, `pocExecutedVerdictCount?`,
`pocAttemptedCount?`, `pocRanCount?` (executions performed), `pocSkippedInfraCount?`. The
per-PoC boolean stays `execution.executed`; there is **no** field named `pocExecuted?` on the
result (its two former meanings are now `pocExecutedVerdictCount?` and `pocRanCount?`). The
Stage-B focused-confirm model verdict (`"CONFIRMED"|"REVISED"|"REFUTED"`) is model-internal and
**MUST NEVER** map to `ScoredFinding.verdict`; only `promoteWithPoc()` after real execution
sets terminal `CONFIRMED`/`POC_EXECUTED` (regression test).

### 3.2 `poc-prompt.ts` — generation prompt (PURE)

`buildPocGenerationPrompt({finding, pocTarget, files, programRules, systemContext?})`.
Nonce-fenced UNTRUSTED files + finding fields + cited source window. Instructs the model to
prefer the **strong (Tier-1) shape** and to fall back to the **harness (Tier-2) shape** only
when the target cannot be driven directly (it is a callback contract — a Uniswap-v4 hook, an
ERC-4626 vault called by a router, etc.). The prompt describes both, plus the §3.3.A
scaffolding allowlist, and asks the model to self-declare `"shape":"static-bound"|
"harness-driven"` (advisory — the §3.3 gates are authoritative):

- **Tier-1 (preferred) — single straight-line `testAuditPoc`:** one `contract`, exactly one
  public no-arg `function testAuditPoc() public` (no modifiers), **no other function/modifier
  declarations**, **straight-line body** (NO `if`/`for`/`while`/`do`/`try`/`assembly`/ternary
  `?:`; no early `return`/`revert`). Deploy `pocTarget.symbol` from `pocTarget.path` (exactly
  one `new`); set up `preconditions`/`triggerRole` with only the allowlisted cheats
  (`vm.prank`/`startPrank`/`stopPrank`, `vm.deal(address,uint256)` ETH-to-EOA only, `vm.warp`/
  `vm.roll`); **make a non-view call directly on that target instance (the DRIVE)**; read the
  same instance after; assert its expected-correct invariant is violated from that post-drive
  read.
- **Tier-2 (fallback, callback targets) — a harness `testAuditPoc`:** permitted a `setUp()`,
  helper functions, and control flow **in setup**, and may `is Test, <§3.3.A base>` (e.g.
  `Deployers`). Deploy the **real** `pocTarget.symbol` from `pocTarget.path` (a mined-salt
  `new pocTarget.symbol{salt:…}` via `HookMiner` is allowed for hooks). Instantiate **only**
  §3.3.A-allowlisted vendored scaffolding (`forge-std`, v4-core `Deployers`, v4-periphery
  `HookMiner`, solmate `MockERC20`, OZ mocks) — **never a contract you declare yourself**,
  never a hand-written fake the target consumes. The single `testAuditPoc` **must** drive the
  target **through the real harness** (e.g. `swap(...)`) — an explicit drive call, never a bare
  `receive()` transfer — and assert with **one** of the two promotable forms: an `assert*`
  reading a real target member after the drive (strongest — **prefer this**); or a
  `vm.expectRevert(<selector>)` guarding that drive. **A no-revert / `assertTrue(true)` body
  will NOT earn a terminal state** (§3.3.B B4) — do not emit one; if you cannot express a
  target-read or a selector-revert, DECLINE instead. This is the der-sc H1/H2 class (inverted
  epoch cap; dead band).
- **HARD RULES (both tiers — the fabrication floor; a violation is rejected, never
  downgraded)** — the model returns the COMPLETE test file:
  - Forbidden: all fabrication/fs/env/process/fork/rpc cheatcodes (§3.3 gate 2 pinned
    list); the HEVM cheatcode address by any means; **any low-level
    `.call/.delegatecall/.staticcall`**; **any inline assembly**; forge-std
    **state-fabrication wrappers** (`StdStorage`/`stdstore`/`checked_write`, `StdCheats`
    `deal(token,…)`/`hoax`/`deployCode`); `vm.sign`.
  - **Declare NO `contract`/`library`/`interface` of your own** (beyond the one test
    contract). Every `new`/base must be either `pocTarget.symbol` (from `pocTarget.path`)
    or §3.3.A-allowlisted **vendored** scaffolding — never a fake you write, never a mock
    the target consumes, never an arbitrary literal address used as a dependency. This is
    the line between the two tiers and repro fabrication.
  - Contract creation: Tier-1 uses only plain `new pocTarget.symbol(...)` (the target, and
    nothing else — §3.3 gate 6); Tier-2 may also
    use `new pocTarget.symbol{salt:…}` with a `HookMiner`-mined salt. Bare
    `create/create2`/`type(X).creationCode` assembly is forbidden on both.
  - `assert*` must be forge-std `Test`/`StdAssertions` (or built-in `assert`). Both tiers
    forbid `assertTrue(true)`/constant-only/deployment-only as a **terminal** proof: Tier-1
    declines them; Tier-2 keeps the PoC but leaves the finding PURSUE (no-revert is not
    terminal). A terminal PoC needs a real target read or a selector-qualified `expectRevert`
    guarding the drive.
  - `testContents ≤ POC_FILE_MAX_BYTES` (24 KB); path is harness-assigned.
- **Output boundary (resolves the body-vs-file ambiguity):** the model returns the
  **complete Solidity test file** as `testContents` (SPDX + pragma + imports + the one
  test contract); the harness assigns only the on-disk path. The AST gates (§3.3) and the
  executor both operate on this full `testContents`; there is no separate wrapper/harness
  layer that could relocate the trust boundary.
- **Decline** → `{testContents:null, rationale}` (needs live fork / a test-authored
  attacker or a hand-written substituted dependency / token-balance setup / signature setup
  / unshown code / no concrete deployable target). Revert-based and callback-driven proofs
  are **no longer** decline reasons — they route to Tier-2.
- Output JSON: `{ testContents: "<full solidity file>" | null, shape?: "static-bound" |
  "harness-driven", rationale: string | null }`.

### 3.3 `poc.ts` — target resolution + AST static gates + promotion

Gates operate on a parsed AST (`@solidity-parser/parser`, literal-aware). Functions are
I/O-free: the caller passes a **canonical-path-keyed parsed closure map**
(`closureAstByPath`), the closure roles/edge graph, `entries`, `remappings`, and the
harness `testPath`. Any AST-unresolvable fact **DECLINES → PURSUE** (fail-safe).

**`resolvePocTarget(finding, entries, closureRolesGraph, closureAstByPath) → PocTarget | null`.**
Primary evidence = first evidence entry after grounding re-anchor. Precedence: (1) the
concrete deployable `contract` whose AST brace-scope encloses the primary grounded line;
(2) else the **unique** concrete deployable entry whose resolved import/inheritance path
reaches the cited code (via `entries` + the roles graph + inheritance linearization);
(3) zero or **>1** candidate, or interface/library/abstract-only evidence with no concrete
reacher → **decline** ("no unique concrete deployable target"). Rule-2 label reads
"resolved deployable target reaching cited code." (Requires exporting
`blockDeclaresSymbol` from `run.ts`.)

**`staticGatePoc(testAst, finding, pocTarget, closureAstByPath, remappings, testPath) →
{passed, reasons, tier?, binding?}`** — on pass returns `tier ∈ {"static-bound",
"harness-driven"}`, and (static-bound only) a `PocBinding {targetSymbol, targetPath,
deployedVar, constructorSpan, driveSpan, assertSpan}` consumed by the executor. It tries
the **Tier-1 static-bound path (gates 1–8)** first; if the PoC fails Tier-1 *only* because
it is harness-shaped (multi-function/`setUp`, control flow in setup, indirect drive, salted
target deploy, a revert-assertion, **or it instantiates any §3.3.A vendored scaffolding —
Tier-1 instantiates the target and nothing else**) — and nothing in the **hard invariants
below** is violated — it falls through to the **Tier-2 harness path (§3.3.B)**. A PoC that
violates a hard invariant DECLINES to PURSUE on **both** paths (no silent downgrade past a
fabrication check). **`CONFIRMED` therefore has zero external-contract dependency in its
assertion path** — the presence of *any* scaffolding is exactly what makes a PoC Tier-2, so
residual-(e) (a doctored vendored mock) can never touch the strong tier.

**Hard invariants (BOTH tiers — a violation is a decline, never a tier downgrade):** the
cheatcode/exfil denylist (gate 2, minus the CREATE2/salt carve-out below), the funding-cheat
constraint (gate 3: only `vm.deal(EOA,uint256)`; never `deal(token,…)`/`stdstore`/`vm.sign`),
**no repo-/test-authored logic contract** (§3.3.A), the **closed-symbol invariant** (next
paragraph), size (gate 4), and the build-info ground-truth target identity (§3.4, enforced at
execution). The Tier-2 relaxation is *structural only* (shape + binding), never a relaxation
of what may fabricate state.

**Closed-symbol invariant (BOTH tiers — the fabrication floor extends past contracts).**
§3.3.A closes *instantiated contracts and bases*, but logic can also enter through **free
functions, `using`-libraries, imported constants, and any imported symbol**. So: **every
`import` and every referenced non-local symbol/call in `testContents` must resolve to exactly
one of** (a) the cited target (its constructor/drive/getter members), (b) the forge-std
assertion surface + the allowlisted `vm.*` cheat members (gate 3) + the benign forge-std
`console`/`console2` log functions (a log cannot fabricate state, and `passed` is parsed from
authoritative summary counts, not console — §3.4; the executor still redacts console output),
or (c) §3.3.A-allowlisted vendored scaffolding (its members/`using` functions). **Any import from a repo `src/`/`test/`/
`script/` path, any call to a test-file-declared or imported free function/library not on the
§3.3.A allowlist, or any unresolved nonlocal symbol → DECLINE** ("out-of-allowlist symbol
`<name>`"). This makes §5's "out-of-allowlist import" rejection a decidable gate, and closes a
Tier-1 `CONFIRMED` that imports a repo helper library which configures the target or deploys a
hidden collaborator before the drive.

**§3.3.A — real-dependency anchor (the harness allowlist).** Every contract *instantiated*
in the test (`new X`, `new X{salt:…}`, or a base the test `is`) must be exactly one of:
(a) **the cited target** `pocTarget.symbol` from `pocTarget.path`; or (b) **allowlisted
vendored scaffolding** — its symbol resolves, through the test's imports (`import {Sym as
Alias}` handled), to BOTH a **known import specifier** on the pinned allowlist
(`forge-std/*`; `@uniswap/v4-core/test/utils/*` incl. `Deployers`; `@uniswap/v4-periphery/`
`…/HookMiner`; solmate `…/test/utils/mocks/MockERC20`; OpenZeppelin `…/mocks/*`) **and** a
resolved file path under a **real-dependency root** (`lib/**` or `node_modules/**`), never
the repo's own `src/`/`test/`/`script/`. Anything instantiated that is not (a) or (b) —
**declines to PURSUE** with a reason that distinguishes the case honestly: a
`contract`/`library` **declared in the test file** → "requires a test-authored contract"; a
symbol from an **unknown specifier** → "unrecognized scaffolding `<spec>`"; a **real,
non-mock collaborator from the repo's own `src/`** that the target legitimately needs (e.g. a
Vault taking a freshly-deployed real Strategy) → **"requires a repo-src dependency
instantiation (out of v1 scope)"** — NOT mislabeled test-authored (it is fail-safe ineligible,
a known coverage gap named in §2/§6, not a fabrication). The allowlist is a pinned constant with a
CI drift test; adding an entry is a spec change. This anchor is what separates *benign
vendored fixtures* (der-sc's `Deployers`/`MockERC20`) from *author-fabricated state* — the
latter can never pass, on either tier. **Clause (b) is a Tier-2-only instantiation grant:**
Tier-1 (`CONFIRMED`) instantiates only clause (a), the target itself (gate 6 is authoritative
for Tier-1); a PoC that instantiates clause-(b) scaffolding is by definition harness-shaped
and routes to Tier-2. So §3.3.A being a "both-tier hard invariant" means *the (a)/(b)
allowlist bounds what may be instantiated at all on either tier* — it does not grant Tier-1
the right to instantiate scaffolding.

**CREATE2/salt carve-out (Tier-2 only, gated by §3.3.A):** gate 2 bans `new X{salt:…}`;
the harness path permits it **only** for a §3.3.A-allowed symbol whose salt is a locally
computed `HookMiner.find(...)` result (v4 hooks require a flag-encoded address — a hard
protocol constraint, not a fabrication). Bare `create/create2`/`type(X).creationCode`
assembly stays banned on both tiers.

**Tier-1 static-bound path (gates 1–8) — mints `CONFIRMED`:**
1. **Shape / straight-line** — exactly one contract; exactly one `function testAuditPoc()`
   (public, no args, no modifiers); **no other function or modifier declarations**; and
   the body AST contains **no** `IfStatement/ForStatement/WhileStatement/DoWhileStatement/
   TryStatement/InlineAssembly/Conditional(ternary)` node and no early `return`/`revert`.
   (This straight-line invariant is what makes gates 7–8 decidable.)
2. **Cheatcode/exfil denylist** — an EXPLICIT, version-pinned set generated from the
   vendored `forge-std/Vm.sol` ABI (fabrication `etch/store/mockCall*`; fs
   `readFile/writeFile/readDir/readLine/copyFile/removeFile/createDir/exists/…`; env
   `env*/setEnv`; process `ffi/prompt*`; fork/rpc `*fork*/rpc*`; serialize
   `serialize*/writeJson`). CI **drift test** fails if vendored `Vm.sol` gains an
   uncategorized method. Rejected via AST: `vm.<m>` / bound-`Vm`-alias `.<m>(`; any
   construction/cast/low-level call of the HEVM address (`0x7109…DD12D` or its keccak
   derivation, incl. split/arithmetic — best-effort, residual §6); `abi.encode*`/`bytes4`
   with a forbidden selector; **any** low-level `.call/.delegatecall/.staticcall`; **any
   inline assembly**; **any contract creation other than an allowlisted `new X`** (no
   `create/create2`, `type(X).creationCode`).
3. **Cheat/forge-std allowlist — call-shape-aware, not path-level.** The ONLY permitted
   cheat calls are **member calls on the canonical `vm` binding**: `vm.prank`,
   `vm.startPrank`, `vm.stopPrank`, `vm.deal(address,uint256)` (the 2-arg ETH overload
   only), `vm.warp(uint256)`, `vm.roll(uint256)`. **`vm.deal`'s recipient is constrained**
   (a `vm.deal(address(target), …)` would fabricate the target's ETH balance and mint a
   hollow "drain" CONFIRMED): the first argument must resolve — through the straight-line
   local dataflow — to an **actor/EOA address** (a `makeAddr`/literal/`msg.sender`-style
   test variable), and is **rejected** when it is `address(binding.deployedVar)`, any other
   deployed contract instance, or any expression data-derived from such an instance. If the
   PoC's precondition is that the target holds funds, that balance must arrive through a
   **real payable path on the target**, not a cheat. Everything else is rejected: any
   **bare or inherited** `deal(...)` / `hoax` / `deployCode` (a `StdCheats` helper reachable
   by extending `Test`), the **3-arg `deal(token,addr,amount)`** overload, `stdstore`/
   `checked_write`, `vm.sign`, `vm.expectRevert`/`expectEmit`, and any `vm.<m>` not in the
   list above (the gate-2 denylist is the pinned complement). forge-std **imports** are
   permitted only for the assertion surface (`Test`/`StdAssertions`, the `assert*` family);
   reject `StdStorage`/`stdstore`/`StdCheats`/`Vm` direct imports. Because gate 1 forbids
   local function declarations, any `assert*` resolves to `StdAssertions`/built-in.
4. **Size** — ≤ `POC_FILE_MAX_BYTES`.
5. **Generation-time target-binding** (Phase-1 best-effort; the CONFIRMED authority is
   §3.4 build-info): from the AST resolve every `import` (handling `import {Sym as Alias}`)
   and require the single `new` target to bind to `pocTarget.symbol` imported from a path
   that **string-canonicalizes** to `pocTarget.path`; reject a test-declared name colliding
   with a cited symbol. Case-insensitive host FS may cause a false-decline (safe).
6. **Target-only instantiation (Tier-1 is strictly zero-scaffolding)** — the test declares
   no contract/library/interface except the test contract, and the **only** instantiation is
   the single `new pocTarget.symbol(...)`; never a mock (test-authored OR vendored), never an
   arbitrary literal address used where a dependency contract is expected (residual §6). A PoC
   that instantiates **any** §3.3.A clause-(b) vendored scaffolding fails this gate **for a
   shape reason** and falls through to the Tier-2 harness path (§3.3.B) — it is not declined.
   (Instantiating a repo-/test-authored logic contract is a §3.3.A **hard-invariant** decline,
   not a fall-through.)
7. **Drive-binding** — a statement `binding.deployedVar.<f>(…)` where `<f>` resolves —
   through `pocTarget`'s **inheritance linearization** over `closureAstByPath` — to a
   **named, non-view, non-pure** function, appearing before the asserted read. A **bare ETH
   value-transfer** into the target's `receive()`/`fallback` is **NOT** a valid drive (§3.4
   excludes a bare value-transfer from `targetFrameObserved`, so crediting it would violate
   `drove ⇒ targetFrameObserved`) — an ETH precondition must arrive through a **named payable
   target function**. Unresolved mutability → decline.
8. **Assertion-binding** — ≥1 `assert*` whose operand data-depends (through straight-line
   local assignments) on a read `binding.deployedVar.<g>(…)` whose statement is **after**
   the drive statement, where `<g>` resolves — through the target's inheritance linearization
   over `closureAstByPath` — to a **`view`/`pure` (non-mutating) getter** (a mutating call as
   the asserted operand, e.g. `assertTrue(target.setFlagAndReturnTrue())`, would let the
   assertion create its own passing state; unresolved mutability → decline). Reject
   constant-only, deployment-only, pre-drive reads. **Reject decidable tautologies**
   (the "non-triviality rule", referenced by Tier-2 B4(ii)): a **unary** `assert*` on a
   **non-constant target bool getter** (`assertTrue(target.isBroken())`, `assertFalse(
   target.solvent())` — the strongest, fully load-bearing form) **passes**; but a **binary
   comparison** must pit the target read against an **independent** operand. This is enforced by
   a **STRICT structural rule** (the airtight promotable shape, not a blacklist of laundering
   spellings) plus a **decidable-constant rejector**:
   - **Strict bare-vs-independent binding** (`hasBoundAssertion`/`isBareTargetRead`): the
     promotable comparison must pit a **BARE target read** (the view read itself, modulo
     value-preserving casts / identity arithmetic / parens under `canonExpr`, and the
     straight-line local binder) against a **target-INDEPENDENT** operand. **A comparison where
     BOTH sides read the target is rejected** — this closes the entire self-referential family
     (`assertEq(b, b + 5 - 5)`, `assertGe(b, uint256(b))`, `assertEq(t.a(), t.b())`) in one rule,
     with no constant-folding arms race. A legit cross-view invariant (`assertEq(t.totalSupply(),
     t.reserve())`) is intentionally **not promotable** here (safe false-negative → Tier-2
     CANDIDATE); a `CONFIRMED` asserts a target read against a fixed expectation.
   - **Decidable-constant rejection** (`constTruth` + `foldConst`): the comparison must not be
     decidably always-true. `constTruth` decides self-comparison, reflexive numeric bounds
     (`>= 0`, `<= type().max`), and offset-inequality (`x != x + k`) over `canonExpr`-normalized
     operands, backed by `foldConst` — a **complete BigInt integer-constant evaluator** (number
     literals, `type(uintN/intN).max/min`, casts with 2's-complement wrap, unary `-`/`~`, and all
     binary arithmetic/bitwise/shift ops) — so every arithmetic *spelling* of a type extreme
     (`type(uint256).max - 1 + 1`, `2 ** 256 - 1`, `~uint256(0)`, `uint256(int256(-1))`) is
     decided, not enumerated. A **unary** bool getter still passes (load-bearing). Approximate
     equality (`assertApproxEqAbs/Rel`) is **excluded from Tier-1** entirely (its model-supplied
     tolerance is not statically verifiable; a too-large delta always passes) → Tier-2 CANDIDATE.
     `hasConstCollapse` additionally rejects any bitwise/boolean combinator (`& | ^ << >> && ||`)
     or arithmetic annihilator (`x*0`, `x-x`) on an operand.
   Together these are **complete decision procedures** for the decidable-constant and
   self-referential classes (bounded — a Tier-1 assertion is one straight-line comparison of a
   target read). The **deployed-target variable is single-assignment** (`isVarReassigned`): a
   rebind (`t = Vault(address(this))`) would re-point the name-keyed drive/read gates at a
   different instance, so any reassignment of `deployedVar` declines — closing the wrong-instance
   hollow. **Machine-gated vs. human-gated boundary (deliberate).** The gates close the
   **deceptive** hollows — where the assertion passes *regardless of the target's real state or
   reads the wrong instance* (a human reviewer can miss `assertLe(b, ~uint256(0))` or a rebind
   that looks like a target read). The remaining, softer residual is **drive/assertion
   bug-relevance** — a *load-bearing* assertion on the real target whose **drive does not exercise
   what is asserted**: a **no-op drive** (`t.noop(); assertEq(t.balance(), 0)`) or a **pre-drive
   snapshot of a field the drive never touches** (`uint x = t.balance(); t.deposit(…);
   assertEq(t.balance(), x)`). These are **TRANSPARENT** to the mandatory human gate (§1(a)) — the
   drive plainly does nothing / reads an unrelated field — and would be co-checked by the Phase-3
   runtime trace, so they are **the human-gated residual, not machine-enforced** (machine-enforcing
   drive→read coupling would need inter-procedural write/read data-flow, which the spike/executor
   phases can revisit if prevalence warrants). This is the principled line: the machine closes what
   a human could be fooled by; the human gate closes what is obvious on inspection.

**Tier-2 harness path (§3.3.B) — mints `POC_EXECUTED`** (only when gates 1/7/8 fail *for
shape reasons* while every §3.3.A hard invariant holds). The harness path CANNOT bind the
target statically (der-sc drives the hook through a real `PoolManager` callback, not a
direct `target.f()`), so its soundness is **deferred to the §3.4 runtime trace** — a
`POC_EXECUTED` is impossible without execution. Static gates on this path:
- **B1. Contract set** — one test contract that may `is Test[, <§3.3.A base>]`, may declare
  `setUp()` + helper functions, and may contain control flow **in `setUp()` and helpers**
  (setup realism) — but the promotable drive+assertion pair inside `testAuditPoc()` is
  constrained by B4 (top-level, unconditional). Every instantiated symbol satisfies §3.3.A
  (this is the load-bearing check). No
  `pocTarget.symbol` may be *declared* in the test file (only imported from `pocTarget.path`).
- **B2. Hard invariants** — the gate-2 denylist (with the CREATE2/salt carve-out), gate-3
  funding constraint, and gate-4 size all hold, evaluated over the **whole file** (setUp +
  helpers + tests), exactly as Tier-1. `deal(token,…)`/`stdstore`/`etch`/`store`/`mockCall*`/
  `vm.sign` ⇒ decline.
- **B3. Target-import present** — `pocTarget.symbol` is imported from a path canonicalizing
  to `pocTarget.path` and is instantiated at least once (`new`/`new{salt}`); else decline
  ("no deployable cited target").
- **B4. Assertion shape — a terminal `POC_EXECUTED` requires a *bound, top-level,
  unconditional* assertion.** Exactly one test function `testAuditPoc()`. **The promotable
  drive+assertion pair must be at the top level of `testAuditPoc()`'s statement list — NOT
  nested under any `if`/`for`/`while`/`do`/`try`/ternary** (setup realism control flow is
  permitted only in `setUp()`/helpers and only *before* the top-level drive, never wrapping
  the drive or the assertion). A drive or assertion nested under control flow **fails closed**
  (an `if(false){assertEq(target.x(),y)}` records nothing) — the gate reads only the top-level
  pair. **Exactly one top-level drive call** is permitted (it becomes `harnessDriveSpan`, B5);
  two or more top-level allowlisted-scaffolding/target calls before the assertion → **decline**
  (ambiguous drive root → fail-safe). The body contains an explicit harness-**drive** call (an allowlisted-scaffolding or
  target call — never a bare value-transfer) and **≥1 of** the two **promotable** forms:
  - **(i) revert-assertion** — a `vm.expectRevert(<selector>)` immediately guarding that
    drive. **The selector is REQUIRED whenever the resolved target declares any named error**
    (a bare selectorless `vm.expectRevert()` is **not promotable** — it admits a
    scaffolding/unrelated revert; it stays non-terminal, `assertionForm:"no-revert"`). At
    execution the matched revert must **originate in the target frame** (§3.4), not in
    scaffolding reached before the target.
  - **(ii) target-read** — an `assert*` whose operand reads a target member
    (`pocTarget.symbol` instance `.<g>()`) after the drive, where `<g>` resolves — through the
    target's inheritance linearization over `closureAstByPath` — to a **`view`/`pure`
    (non-mutating) getter**. A mutating call as the asserted operand (e.g.
    `assertTrue(target.setFlagAndReturnTrue())`, which creates its own passing state) or an
    operand whose mutability is AST-unresolvable is **not a valid target-read** → the assertion
    is bucketed `"no-revert"` if a valid top-level drive exists (non-terminal, PoC attached),
    else `"none"` → decline (fail-safe; consistent with the bucket rule below). **The asserted value
    must data-depend on `<g>`'s return through a RESTRICTED, load-bearing dataflow** — only
    **top-level, unconditional, post-drive** local assignments, comparisons/arithmetic on the
    read value, literals/constants, and the `assert*` call itself. **A user-defined helper call,
    or any non-target/scaffolding call, in the assertion's dataflow is forbidden** (it would let
    a `pure` helper swallow the read — `assertTrue(alwaysTrue(target.getX()))` returns true
    regardless of `getX()` → the target read is non-load-bearing). It is also subject to the
    **gate-8 decidable-tautology rejection / non-triviality rule** (self-comparison,
    type-reflexive predicate, or constant-collapsing arithmetic → not load-bearing). Such a PoC is recorded `"no-revert"`
    (non-terminal) — the read must **syntactically participate and the assertion must not be a
    decidable tautology** (semantic bug-relevance beyond that is the human-gated residual
    §1(a), not machine-enforced). This mirrors Tier-1 gate 8; Tier-1 needs no helper ban
    because gate 1 forbids helper declarations, but B1 permits them, so the ban is stated here.
  `poc.assertionForm ∈ {"revert","target-read"}` is recorded for a promotable pair;
  `"no-revert"` for a PoC that has a top-level drive but only a non-(i)/(ii) assertion (bare
  `assertTrue(true)`, selectorless `expectRevert`, or a mutating/unresolved read) —
  **non-terminal**: it **passes compilation/execution but stays PURSUE** with the PoC + trace
  **attached**, reason `"harness ran, no-revert only (not a terminal verdict)"` (product
  finding: such a body corroborates the finding essentially not at all — "did not revert" is
  for many bug classes the *opposite* of the expected signal — so it must never share the
  terminal bucket with a bound assertion). `"none"` for a test with **no top-level drive** or
  **no assertion at all** → **declines** (`staticGate.passed:false`, not executed).
- **B5. Emit `harnessDriveSpan`, no full binding** — the full static `binding` is `undefined`
  (no static drive/assert binding), but the gate **does** emit `poc.harnessDriveSpan` = the AST
  span of **the single top-level B4 drive statement** (the allowlisted-scaffolding/target call
  that the assertion is bound to), and `tier:"harness-driven"`. The executor's
  `targetFrameObserved` (§3.4) is scoped to the dynamic subtree rooted at **exactly this
  `harnessDriveSpan` call** — NOT any other test-body statement. A target frame reached via a
  **user-defined helper call** (`prime(){target.touch();}` invoked from the body) or any
  non-`harnessDriveSpan` statement does **not** satisfy `targetFrameObserved` (a helper call is
  never a valid drive-frame root; the drive must be the B4-recognized top-level call itself).

**`wouldPromotePoc({poc, execution}) → "static-bound" | "harness-driven" | null`** is the
**GO-independent** terminal-evidence predicate (the tier a PoC's execution *earns* on its own
merits, independent of any spike enablement) — this is what the §7 spike grades (its `promoted`
field) and what `validateSpikeGoArtifact` recomputes `enableStatic`/`enableHarness` from, so the
GO decision is **not circular**:
- returns `"static-bound"` iff `poc.tier==="static-bound" ∧ staticGate.passed ∧ executed ∧
  compiled ∧ passed ∧ execution.deployedTargetPath === pocTarget.path ∧ execution.drove`;
- returns `"harness-driven"` iff `poc.tier==="harness-driven" ∧ staticGate.passed ∧
  poc.assertionForm ∈ {"revert","target-read"} ∧ executed ∧ compiled ∧ passed ∧
  execution.deployedTargetPath === pocTarget.path ∧ execution.targetFrameObserved`;
- else `null`.

**`promoteWithPoc({base, poc, execution, activeGo?}) → {verdict, reason}`:** `base.verdict
!== "PURSUE"` → return `base`. Let `t = wouldPromotePoc({poc, execution})`. **`activeGo`** is
the validated Phase-2 GO artifact's tier-enable flags (`{enableStatic, enableHarness}`),
threaded in from the run's active GO (§4); in Phase-1/generation-only it is absent and **no
terminal verdict is mintable**. Production promotion is `wouldPromote` **gated by the matching
enable flag**:
- **`CONFIRMED`** iff `t==="static-bound" ∧ activeGo?.enableStatic===true`.
- **`POC_EXECUTED`** iff `t==="harness-driven" ∧ activeGo?.enableHarness===true` (the §3.4
  `targetFrameObserved` is a non-static target frame **scoped to the `testAuditPoc()` subtree**,
  satisfied by an indirect/callback frame). **No `POC_EXECUTED` without execution** (a
  generation-only run leaves the harness PoC at PURSUE with reason "harness PoC awaiting
  execution"); **no `POC_EXECUTED` for a no-revert-only PoC** (`wouldPromotePoc` returns null
  for `assertionForm∉{revert,target-read}`; stays PURSUE, PoC attached, per B4).
- **`t !== null` but the matching `enable*` flag is false** → PURSUE ("tier-not-enabled-by-spike")
  — the PoC earned its tier on evidence but this build's spike did not enable it.
- Else **PURSUE** with the specific reason (declined / static-gate / not-executed /
  deps-unavailable / did-not-compile / assertion-did-not-hold / target-path-mismatch /
  no-target-frame / no-revert-only / executor-error / generation-failed / requires-live-fork /
  requires-test-authored-contract / requires-test-authored-dependency /
  requires-repo-src-dependency / unrecognized-scaffolding / harness-awaiting-execution).
  **Never DROP.**

### 3.4 `poc-executor.ts` — `PocExecutor` interface + `dockerPocExecutor`

`execute({targetRoot, testContents, binding, harnessDriveSpan, pocTarget, timeoutMs}) →
PocExecResult` (`{executed,compiled,passed,drove,targetFrameObserved,deployedTargetPath,
ranTests,passedTests,failedTests,skippedTests,exitCode,summary,reason}`). `binding` is
`undefined` on the harness path (no static drive/assert spans); instead `harnessDriveSpan`
(§3.3.B B5 — the single top-level B4 drive span) is passed, and the executor computes
`targetFrameObserved` **only within that span's dynamic trace subtree** (§3.4) — NOT the whole
`testAuditPoc()` subtree, so a helper-rooted target frame cannot satisfy it. §4 passes
`harnessDriveSpan` for `tier==="harness-driven"` (and `binding` for `"static-bound"`); a
harness run without `harnessDriveSpan` is a wiring error → `{executed:false}` (fail-safe). `dockerPocExecutor` (env-gated `SIDECAR_POC_EXEC=1`
**and** a `validateSpikeGoArtifact()`-valid Phase-2 GO artifact, §7; else
`{executed:false, reason:"…"}`). **Catches ALL infra failures → `{executed:false,
reason:"executor error: <bounded>"}` — never throws.**

- **Allowlist scratch copy** into an OS temp dir — the executor performs its **own full
  transitive import resolution** from `pocTarget` + the PoC (NOT the budget-truncated
  finder closure), copying only the resulting `.sol` set + `foundry.toml`/`remappings.txt`
  + `forge-std`. Non-`.sol` repo files (`.env*`, `*.json`, `.npmrc`, `hardhat.config.*`,
  `.git`, keys) are **never copied** (a compiler diagnostic cannot echo their contents).
  Write `testContents` verbatim to the harness-fixed `test/AuditPoc_<slug>.t.sol` (fail if
  it exists).
- **Merged `foundry.toml`**: preserve remappings/`solc_version`/optimizer/`via_ir`/`src`/
  `libs`; force only `ffi=false`, `fs_permissions=[]`; strip `[rpc_endpoints]`/
  `eth_rpc_url`/fuzz seeds.
- **Trusted assertion-framework provenance (executor trust boundary — the audited
  repo is UNTRUSTED).** The static gate recognizes `forge-std` `assert*`/`Vm` **by import
  specifier and by name** (§3.3 gate 3); it cannot see the *bytes* those specifiers resolve
  to. A hostile target repo can ship a `remappings.txt` (or `lib/`) that redirects
  `forge-std/` to target-controlled source whose `assertEq`/`assertTrue` is a **no-op** — a
  gate-passing, load-bearing-looking assertion whose forge PASS is meaningless (a hollow
  `CONFIRMED`). Therefore the executor **MUST** source the entire assertion framework
  (`forge-std`, and any built-in assertion surface) **only from the pinned image**, and
  **MUST drop/override every target-supplied remapping whose left-hand side resolves the
  assertion framework** (`forge-std/`, `Vm`, `StdAssertions`, `Test`) rather than preserving
  it, and **never copies a target-tree `forge-std`** into the scratch. The audited repo's
  `forge-std` bytes never participate. (Static classification stays unchanged — this is an
  executor-provisioning invariant, co-validated by the build-info bytecode identity below;
  a fake framework cannot forge the pinned image's `Test.sol` artifact hash.)
- **Pinned toolchain**: the image (`<IMAGE@sha256:…>`) pins a specific forge + forge-std
  version; the trace/summary parser is written against that version and §5.7 proves it.
- **Fixed non-model argv**: `docker run --rm --network none --user <non-root> --cpus=2
  --memory=2g --pids-limit=256 --read-only --tmpfs /tmp -v <scratch>:/work:rw -w /work
  --env-file /dev/null <IMAGE> forge test --match-path test/AuditPoc_<slug>.t.sol
  --match-test '^testAuditPoc$' -vvvv` under a **copy-set-size-aware** timeout
  (`min(900s, 300s + 60s·⌈copySetBytes/100KB⌉)`; kill on expiry). `/work` rw (scratch is
  throwaway, removed in `finally`); root read-only; empty env. `--ffi` is structurally
  impossible.
- **Deterministic pass** (never bare exit-0): parse forge's **summary counts**
  (authoritative; a `console.log` cannot spoof them). `passed` iff `passedTests===1 ∧
  failedTests===0 ∧ skippedTests===0` and the passed test is `testAuditPoc`. `ranTests===0`
  → `passed:false`.
- **Ground-truth target-path binding — keyed on the DEPLOYED instance, not a name lookup**
  (a name lookup would re-open the same-name-collision divergence): (1) in the `-vvvv`
  trace find the `CREATE` **or `CREATE2`** (the harness path deploys hooks with a
  `HookMiner`-mined salt) whose resulting contract is `pocTarget.symbol` and capture its
  **deployed address** and **creation/runtime bytecode**; (2) match that bytecode to a
  forge **build-info / artifact** entry — comparing the **metadata-stripped runtime-bytecode
  template** with immutables masked and appended constructor args removed (a literal
  exact-byte compare fail-closes for immutable/constructor-arg targets; the normalization
  must NOT collapse distinct-source same-name contracts) — unambiguous even under same-name
  collision; (3) `deployedTargetPath` = that artifact's recorded source path,
  resolved to a **`realpath` under the scratch root** and mapped back through the
  scratch-copy source manifest to a **POSIX repo-relative** path; CONFIRMED requires it to
  equal `pocTarget.path` **byte-for-byte** (both canonicalized the same way). **Any**
  ambiguity — more than one `pocTarget.symbol` CREATE, no bytecode→artifact match, an
  unmapped path — sets `deployedTargetPath=null` → PURSUE (fail closed). (The `new
  pocTarget.symbol` CREATE the drive keys on is the test-level instance from `binding`;
  a closure contract that internally deploys another `pocTarget.symbol` shares the same
  `pocTarget.path`, so this does not weaken the check.)
- **`drove` / `targetFrameObserved` — both scoped to the `testAuditPoc()` subtree, NOT
  `setUp()`.** forge emits `setUp()` and the matched test as **separate trace subtrees**; the
  parser considers **only the `testAuditPoc()` subtree**. A non-STATICCALL frame at the target
  address that occurs during `setUp()` (a `HookMiner`-salted `new` triggers `beforeInitialize`
  on `poolManager.initialize`; a bare ETH send hits `receive()`) is **explicitly excluded** —
  it proves the fixture touched the target, not that the test-body drive entered it. Within
  the `testAuditPoc()` subtree:
  - **`drove` (Tier-1)** = a **direct** non-static call from the test contract to the target —
    the statically bound `binding.driveSpan`.
  - **`targetFrameObserved` (Tier-2)** = a non-STATICCALL target frame inside the dynamic
    subtree rooted at **exactly the `poc.harnessDriveSpan` call** (§3.3.B B5 — the single
    top-level B4 drive the assertion is bound to), NOT any other test-body statement. It may
    be reached **indirectly** (`swapRouter → PoolManager → hook.beforeSwap`), which is why
    `POC_EXECUTED` ranks below `CONFIRMED`. A target frame reached from a **user-defined helper
    call** or any non-`harnessDriveSpan` statement, or a **bare value-transfer into
    `receive()`/`fallback`**, does **NOT** count (a helper is never a valid drive-frame root; a
    bare transfer is not a driven code path). For the
    **revert-assertion form**, the target frame must appear inside the `vm.expectRevert`-guarded
    drive's subtree AND **the matched revert must originate in (propagate out of) the target
    frame** — a revert thrown by scaffolding (a router/PoolManager) *before* control reaches the
    target, even with an unrelated earlier target frame in the same guarded subtree, does NOT
    satisfy the revert form (it sets `targetFrameObserved:false` for that assertion → PURSUE
    "no-target-frame"). The target address appearing **only** under STATICCALL, only in
    `setUp()`, or not at all → both false → the PoC stays PURSUE ("no-target-frame").
  - **Result invariant (pinned by §5):** `execution.drove === true ⇒ execution.targetFrameObserved
    === true` (a direct in-body drive is a fortiori an in-body target frame); the executor
    never emits `drove:true, targetFrameObserved:false`.
  `assertionExecuted` is **not** a separate trace check — Tier-1's straight-line gate + forge
  PASS guarantees the unconditional assertion executed; a Tier-2 `expectRevert`/`target-read`
  form + forge PASS (with the §3.4 summary-count parse) guarantees its assertion ran (a
  reverting `expectRevert` that did not reach the guarded drive fails the test, not passes it).
  The **no-revert form does not promote** (§3.3.B B4) — there is no assertion to make the forge
  PASS load-bearing, so it never earns a terminal state.
- **solc offline**: uncached solc under `--network none` → `compiled:false,
  reason:"deps unavailable"` → PURSUE.
- **Redaction**: bounded trace/summary tail, `console.log` + secret/`0x`-key tokens
  stripped. Remove scratch in `finally`.

### 3.5 `model-client.ts` — `pocModelCall`

`pocModelCall(prompt, options?)` defaulting to `CONFIRM_DEFAULT_MODEL` (`gpt-5.5`;
`SIDECAR_POC_MODEL` override). Malformed JSON/transport/timeout → surfaced as a
generation failure (never a crash that loses the finding — §4).

## §4 Wiring

- `run.ts` `runFinder(input, callFinder?, refute?, confirm?, generatePoc?, executePoc?,
  activeGo?)` — new callbacks + the validated GO flags appended after `confirm`. **`activeGo`
  is sourced from `validateSpikeGoArtifact()` on the committed `SPIKE_RESULT.json`** (the same
  object §3.4's executor gate reads); it is `undefined` in Phase-1/generation-only and in any
  run without a valid GO, so no terminal verdict is mintable then. After the scoring loop, for
  each `verdict==="PURSUE"` with `generatePoc` present, in a **per-finding try/catch** (a throw
  → PURSUE with reason, finding preserved): `resolvePocTarget` → generate → parse+`staticGatePoc`
  (returns `tier` + `binding`/`harnessDriveSpan`) → (if gate passed ∧ `executePoc` present)
  execute (passing `binding` when `tier==="static-bound"`, else `poc.harnessDriveSpan`) →
  `promoteWithPoc({base, poc, execution, activeGo})`
  (three-way: `CONFIRMED` / `POC_EXECUTED` / PURSUE — the tier gated by its `activeGo.enable*`
  flag). A `harness-driven` gate-pass with no `executePoc` stays PURSUE
  ("harness-awaiting-execution"); a tier whose `enable*` flag is false stays PURSUE
  ("tier-not-enabled-by-spike"). Absent callbacks leave the loop + output unchanged.
- `sweep.ts` `auditEntry` gains `poc: boolean`; when `live && poc` composes `generatePoc`
  (`pocModelCall`) + `executePoc` (`dockerPocExecutor`). **Consumer surface:** renderers
  add PoC sections only when ≥1 finding carries a `poc`; each renders its own atomic §1 tier
  label (`CONFIRMED` and `POC_EXECUTED` shown as **distinct** rows, never summed); **severity
  and confirmation are orthogonal — neither CONFIRMED nor POC_EXECUTED is ever reordered above
  a higher-severity PURSUE, and POC_EXECUTED is never rendered as/above CONFIRMED**; a top
  banner leads with a one-line **state glossary** — "CANDIDATE = generated, not executed ·
  CONFIRMED = direct-drive, executed (strong) · POC_EXECUTED = harness-driven, executed
  (weaker) · PURSUE = grounded, not proven · DROP = rejected" — then states "CONFIRMED = direct-drive
  static-bound proof; POC_EXECUTED = harness-driven, trace-observed, weaker (the target is
  driven indirectly and/or the proof is a bound revert-assertion rather than a direct state
  read); both are human-review-required and local-deploy only; absence does not lower severity
  — these classes still cannot earn either: live fork, test-authored attacker/dependency,
  token-balance-dependent (ETH-only funding), and signature-dependent" and a coverage line
  "executor ran on X/Y eligible findings (Z skipped: deps-unavailable / executor-off /
  class-ineligible / **tier-not-enabled-by-spike**)". PURSUE reasons distinguish class-ineligible
  vs **assertion-did-not-hold** (neither exoneration nor confirmation — a one-line note says so)
  vs **no-target-frame** vs **no-revert-only** (harness ran, PoC attached, not terminal) vs
  **tier-not-enabled-by-spike** (the finding IS eligible and the PoC earned its tier on
  evidence, but this build's spike did not enable that tier — a one-line note says so, so a
  consumer never reads it as "checked and failed"; under a `CONFIRMED`-only first ship *every*
  harness-eligible finding lands here) vs infra. Update **both**
  `buildPursueMarkdown` **and** `buildDedupedPursueMarkdown` (both filter `verdict==="PURSUE"`
  today and would drop `CONFIRMED`/`POC_EXECUTED` — both must roll up as non-PURSUE).
  `SweepEntryOutcome`/`SweepSummary.totals` gain the same canonical counters as
  `FinderRunResult` (§3.1): `confirmedVerdictCount`, `pocExecutedVerdictCount` (the
  POC_EXECUTED terminal tally — never summed with `confirmedVerdictCount`), `pocAttemptedCount`,
  `pocRanCount` (executions performed), `pocSkippedInfraCount`.
- `cli.ts`: `--poc` (single + sweep), honored only with `--live`. Usage/README document it,
  `SIDECAR_POC_EXEC`, the GO-artifact requirement, the local-deploy scope, the ceiling.
- `README.md`: replace the "nothing executes a PoC / Foundry lane parked" text; add the
  opt-in stage, ceiling, §7 spike gate, and the CANDIDATE label (below).

## §5 Acceptance criteria & tests (split by build phase — §7)

**Phase-1 (generation-only; buildable now):**
1. `pnpm typecheck` clean; `pnpm vitest run src/sidecar-solidity` green — existing suites
   untouched; **no-`--poc` `--live` output byte-identical**, pinned by an exact-bytes
   fixture covering **the sweep JSON path** (assert `confirmedVerdictCount` etc. absent, not `0`).
2. `poc.test.ts` (AST gates, pure). Each rejected: `vm.store`, `vm . etch`,
   `vm./**/mockCall`, `"/*"`-in-string hiding `vm.etch`, `Vm z=vm; address(z).call(...)`,
   `abi.encodeWithSignature("etch...")`, `bytes4(keccak256("store(...)"))`,
   `stdstore.checked_write(...)`, bare/inherited `deal(token,addr,x)` and the 3-arg
   overload, **`vm.deal(address(target), x)` / `vm.deal` to a deployed-contract instance**,
   `vm.sign(...)`, `assembly{ create2(...) }` / `type(X).creationCode`, a bespoke
   `contract Fake`, an `import {Target as T}` + same-basename-different-path stub, a
   non-`.sol`/out-of-allowlist import, a fake local `function assertEq(...)` helper,
   **a decidable tautology (`assertEq(x,x)`, `assertGe(uintGetter(),0)`, `assertTrue(x*0==0)`)
   → decline**, **an `import` of / call to a repo-`src/` free function or `using`-library not
   on the §3.3.A allowlist → decline ("out-of-allowlist symbol")** (the closed-symbol
   invariant). Each **accepted** (Tier-1): `vm.prank`/`vm.startPrank`/`vm.stopPrank`,
   `vm.deal(addr,uint)` (2-arg), `vm.warp`, `vm.roll`. A valid straight-line **target-only**
   deploy→(optional warp)→non-view-drive→post-drive-read→**assert against an independent
   literal/constant** PoC passes with `tier:"static-bound"` and
   yields a `PocBinding`. **Fall-through (not decline) cases** — a straight-line PoC that is
   Tier-1-shaped except it (a) instantiates vendored `MockERC20`, or (b) uses a selector
   `vm.expectRevert` guarding a direct target drive, routes to `tier:"harness-driven"`, NOT
   rejected (a `contract Fake`/repo-mock still hard-declines).
   **Tier-2 (§3.3.A/§3.3.B) cases:** a harness PoC — `contract AuditPoc is Test, Deployers`
   with `setUp()` (control flow allowed), a `new Target{salt:HookMiner.find(...)}` deploy,
   an indirect `swap(...)` drive in `testAuditPoc`, and a selector
   `vm.expectRevert(Target.Err.selector)` — passes with `tier:"harness-driven"`,
   `assertionForm:"revert"`, `binding:undefined`. **Declines** (hard-invariant or §3.3.A): a
   harness PoC that declares its own `contract FakeOracle`; one importing a **repo-authored**
   (`src/`/`test/`) mock; one importing an **unknown-specifier** base; a `new X{salt:0x123}`
   with a non-`HookMiner` literal salt; a harness PoC using `deal(token,…)`/`stdstore`/`vm.sign`.
   **B4 buckets:** a harness PoC with a top-level drive whose only assertion is
   `assertTrue(true)`, a **selectorless `vm.expectRevert()`** (target declares named errors),
   a **mutating** asserted read (`assertTrue(target.setFlagAndReturnTrue())`), or a
   **helper-swallowed** read (`assertTrue(alwaysTrue(target.getX()))` — a user-defined helper
   in the assertion dataflow makes the target read non-load-bearing) → gate-pass
   `assertionForm:"no-revert"` → non-terminal PURSUE ("no-revert-only"), PoC attached; a PoC
   with **no top-level drive** (incl. a Tier-1 drive that is a **bare ETH value-transfer** to
   `receive()`, not a named payable call → decline) or **no assertion** → `assertionForm:"none"`
   → **decline** (`staticGate.passed:false`, not executed); a PoC whose promotable
   drive+assertion pair is **nested under `if`/`for`/ternary** → the gate reads only top-level →
   `"none"`/decline (an `if(false){assertEq(...)}` cannot mint a verdict); a Tier-2 `assert*`
   whose operand is a **view/pure** target getter reached through only top-level unconditional
   post-drive assignments/comparisons (no helper) → `assertionForm:"target-read"`.
   `resolvePocTarget`: interface/library-only → decline; multi-entry ambiguity → decline.
   `promoteWithPoc` truth table (tier-gated by `activeGo`): **CONFIRMED** only when
   `activeGo.enableStatic ∧ tier==="static-bound" ∧ staticGate ∧ executed ∧ compiled ∧ passed
   ∧ deployedTargetPath===pocTarget.path ∧ drove`; **POC_EXECUTED** only when
   `activeGo.enableHarness ∧ tier==="harness-driven" ∧ assertionForm∈{revert,target-read} ∧
   staticGate ∧ executed ∧ compiled ∧ passed ∧ deployedTargetPath===pocTarget.path ∧
   targetFrameObserved`; **a static-bound pass under an `enableStatic:false` GO → PURSUE
   ("tier-not-enabled-by-spike")** (and symmetrically for harness); a `harness-driven`
   gate-pass with `executed:false` → PURSUE ("harness-awaiting-execution"); an
   `assertionForm:"no-revert"` gate-pass → PURSUE ("no-revert-only") even when executed+passed;
   every other combo → PURSUE-with-reason; a `CONFIRMED` **or** `POC_EXECUTED` record always has
   `humanGated ∧ runSpecific ∧ label ∧ assertionForm`, and `POC_EXECUTED` never sets
   `tier:"static-bound"`.
3. `poc-prompt.test.ts`: prompt names `pocTarget`; describes **both** tiers (prefer
   static-bound; harness fallback for callback targets); forbids the full denylist + flags +
   **self-declared** contracts + assembly + forge-std fabrication wrappers + `vm.sign`;
   lists the §3.3.A scaffolding allowlist and the `HookMiner`-salt carve-out; defines the
   decline shape (revert/callback are NOT declines).
4. `run.test.ts`: injected fakes, **with `activeGo` enable flags** — PURSUE + static-bound gate
   + passing fake exec (path-match + drove) + `enableStatic:true` → CONFIRMED; the **same
   static-bound pass under `enableStatic:false` (harness-only GO) → PURSUE
   ("tier-not-enabled-by-spike")**; PURSUE + harness-driven gate (`assertionForm:"revert"` or
   `"target-read"`) + passing fake exec (path-match + targetFrameObserved) + `enableHarness:true`
   → POC_EXECUTED; the **same harness pass under `enableHarness:false` (CONFIRMED-only GO) →
   PURSUE ("tier-not-enabled-by-spike")**; **harness-driven gate with `assertionForm:"no-revert"`
   + passing fake exec → PURSUE ("no-revert-only"), PoC attached** (never POC_EXECUTED); **a fake
   exec reporting `targetFrameObserved:false` (setUp-only frame) → PURSUE ("no-target-frame")**;
   harness-driven gate with NO `executePoc` → PURSUE ("harness-awaiting-execution"); gate-failed /
   target-path-mismatch / no-drive / no-target-frame / assertion-failed / declined → PURSUE;
   thrown `executePoc` → PURSUE; DROP untouched; Stage-B `"CONFIRMED"` never terminal; no bare
   `verdict==="CONFIRMED"` or `"POC_EXECUTED"` without `humanGated` in any rendered/serialized
   path; the serialized record co-carries `poc.label` + `poc.assertionForm` beside `verdict`;
   the sweep renderer shows CONFIRMED and POC_EXECUTED as distinct rows and never sums them.
5. `Vm.sol` drift test.
6. `git diff --stat` scoped; zero `apps/web/**` imports.

**Phase-2 (spike gate — §7): a recorded, schema-valid GO artifact is a prerequisite for Phase 3.**

**Phase-3 (executor; INACTIVE until a valid GO artifact exists):**
7. **Toolchain-parser prerequisite:** against the pinned image, a committed valid-PoC
   fixture — whose target declares an `immutable` and takes **constructor args** (so the
   metadata-stripped/immutable-masked bytecode→artifact match is exercised on the
   non-trivial path, not a placeholder-free contract) — yields `passed ∧ drove ∧
   deployedTargetPath===pocTarget.path`, proving the summary-count, trace, and build-info
   parsers work on that exact forge version — a hard gate before any other Phase-3 test.
8. `poc-executor.test.ts` (**docker+forge-guarded** `skipIf`): hollow fixture → static gate
   rejects (no exec); zero-tests fixture → `passed:false`; a **same-name-collision fixture
   that co-locates BOTH `Foo` artifacts on disk** and whose PoC deploys the non-cited `Foo`
   → the bytecode→artifact derivation yields `deployedTargetPath !== pocTarget.path` →
   PURSUE (this proves the derivation is instance/bytecode-keyed, not name-keyed); a
   secret-file-import fixture → import gate rejects and the secret never reaches `summary`;
   scratch removed; host unchanged. **Tier-2 fixtures:** a harness fixture that deploys the
   real target and drives it via an intermediary **from `testAuditPoc()`** so the target
   executes only as an **indirect callback** → `targetFrameObserved:true` ∧ `drove:false` →
   **POC_EXECUTED** (the canonical der-sc shape); **a fixture whose ONLY non-static target
   frame is in `setUp()`** (a `HookMiner`-salted deploy triggering `beforeInitialize`, or a
   `receive()` from a setUp ETH send) with a trivial `testAuditPoc` → `targetFrameObserved:false`
   → PURSUE ("no-target-frame") — the load-bearing scoping test; **a fixture whose only target
   frame is under a user-defined helper called from the body (`prime(){target.touch();}`) while
   the `harnessDriveSpan` drive is unrelated scaffolding → `targetFrameObserved:false` → PURSUE**
   (the frame must be in the exact `harnessDriveSpan` subtree, not a helper); a fixture whose
   target address appears in the trace **only under STATICCALL** → `targetFrameObserved:false`
   → PURSUE; a
   fixture where the test-body drive enters the target directly → `drove:true` **and**
   `targetFrameObserved:true` (pins the `drove ⇒ targetFrameObserved` invariant; assert the
   executor never emits `drove:true, targetFrameObserved:false`); a `CREATE2` mined-salt target
   deploy → the bytecode→artifact match still binds `deployedTargetPath` (proves CREATE2
   handling). Plus a `wouldPromotePoc` unit test — a genuine harness row (`executed ∧
   targetFrameObserved ∧ assertionForm:"target-read"`) returns `"harness-driven"` with **no
   `activeGo`** (proves the spike's `promoted` is non-circular), while a no-revert row returns
   `null`. Plus a `validateSpikeGoArtifact` unit test with a negative fixture per GO predicate
   (incl. a schema-valid `verdict:"GO"` whose recomputed predicates fail → rejected; **a row
   claiming genuineness with `receipt:null` or a `receipt` whose `wouldPromotePoc` recompute
   returns `null` (e.g. `assertionForm:"no-revert"`, or `targetFrameObserved:false`) →
   rejected** (the validator derives `promoted`/`achievedTier` from the receipt, never a trusted
   boolean); **a missing `artifact.offlineBuild` or one whose `targetId` does not resolve →
   rejected**; **an artifact whose recorded `enableStatic`/`enableHarness` disagrees with the
   value recomputed from the per-finding array → rejected** (flags are not trusted inputs); an
   artifact faking yield by marking **ineligible** rows `humanConfirmedGenuine`/`attempted` →
   rejected by the eligible-subset recompute; a row-consistency violation such as
   `humanConfirmedGenuine ∧ ¬executed`, or a **promoted row left `humanConfirmedGenuine:false ∧
   acceptedHollow:false`** (the promoted-XOR gap) → rejected; an artifact where **all genuine
   yield comes from `E_s` but the rows are marked `eligibleTier:"harness-driven"`** (or the
   `achievedTier` mismatches the eligible tier) → the per-tier `achievedTier`-keyed numerators
   reject it, and `enableHarness` is false; a **thin harness tier** (`|E_h| < 3`, or `|E_h| ≥ 3`
   but `pocExecutedHarnessEligible === 0`) → `enableHarness:false` while `enableStatic` may still
   be true (partial GO); and a **duplicate-id** artifact repeating one confirmed eligible id
   across `pursueSampleIds`/`findings` → rejected by the uniqueness/bijection check).
9. A real-target **offline whole-project build** completes within the timeout on the
   Phase-2 targets.

## §6 Risks & honest limits

- **Neither tier is proof** (§1). `CONFIRMED` = "real target deployed (build-info verified)
  + **direct** non-static drive + post-drive assertion executed"; `POC_EXECUTED` = "real
  target deployed (build-info verified) + its bytecode executed **in the `testAuditPoc` drive
  subtree** (possibly via callback) under a passing test with a bound assertion (target-read
  or selector-revert)" — NOT that the assertion captures *this* bug, and for `POC_EXECUTED`
  not even that the target was driven directly. A PoC whose only assertion is no-revert earns
  **no** terminal state (stays PURSUE, PoC attached). Both terminal tiers are human-gated,
  run-specific; the machine token always co-carries `humanGated` + `label` + `assertionForm`,
  and the two tiers are never merged.
- **Residual fabrication surface (accepted, human-gated):** an obfuscated cheatcode-address
  the scanner misses; an arbitrary literal address supplied where a real dependency is
  expected; a true-yet-irrelevant assertion; **and, newly admitted with the harness tier,**
  a vendored dependency under `lib/`/`node_modules/` that itself fabricates the asserted
  state (the §3.3.A anchor allowlists by import specifier + real-dependency path, not by
  content hash) and a `POC_EXECUTED` whose harness drove the target but not through the
  *cited* vulnerable branch. The **no-repo/test-authored-logic-contract** invariant (§3.3.A)
  still closes the bespoke-fake and author-written-mock vectors on both tiers — that line,
  not "no scaffolding at all", is the fabrication floor. Content-hash pinning of the
  allowlist is the named future hardening.
- **Coverage — two tiers, honestly ranked.** The strong `CONFIRMED` tier stays narrow:
  single-target, **direct-drive**, local-deploy — access-control, re-initialization,
  ETH/parameter accounting, where a plain deploy-and-call PoC suffices. The `POC_EXECUTED`
  tier extends reach to the **harness/callback class** — Uniswap-v4 hooks and other
  contracts a real router/manager drives — **which is exactly the der-sc class that
  motivated #179**: der-sc's human PoC (`test/AuditPoC.t.sol`, re-run 2026-08-29, `4/4
  PASS`) deploys the real `RelativeIndexHook` and proves H1/H2 through a real `PoolManager`,
  and now lands as `POC_EXECUTED`. Still ineligible on **both** tiers (stay PURSUE): live
  fork, a **test-authored** attacker or hand-written substituted dependency, a **real
  repo-`src/` collaborator** the target legitimately needs (non-goal #7 — fail-safe, honestly
  labeled, not mislabeled test-authored), token-balance-dependent (ETH-only funding),
  signature-dependent (§2). Actual per-tier prevalence in an
  unfiltered PURSUE population is unknown until the Phase-2 spike measures it (§7); the spike
  must sample **both** an eligible direct-drive subset and the harness subset (der-sc is a
  valid harness-subset target); the banner states absence of either tier does not lower
  severity.
- **Harness-tier false-accept confidence is bounded by the count of *promoted* harness rows
  in the spike.** `enableHarness` forces the gates to be *exercised* on `|E_h| ≥ 3` harness
  generations and requires `≥ 1` genuine promoted `POC_EXECUTED` (§7), but the
  `acceptedHollow === 0` soundness gate for the weaker tier rests on however many harness rows
  actually promote — which can be as few as one in a first spike. This is inherent to
  measuring a rare class; a **follow-up re-spike is expected as harness volume grows**, and
  `POC_EXECUTED` stays opt-in + human-gated until then. Disclosed, not a gate.
- **Docker-on-Mac vs the 2b-sandbox Actions decision** — deliberate override; containment
  (no network, non-root, read-only root, empty env, allowlist scratch, `ffi=false`,
  `fs_permissions=[]`, fixed argv, caps, timeout) bounds untrusted model-Solidity;
  `PocExecutor` keeps Actions a drop-in. Case-insensitive host FS gives only false-declines.
- **Inert-on-real-targets risk** — whole-project offline compile can time out / miss an
  unvendored dep → PURSUE. Operator pre-flight: `forge install` / `git submodule update
  --init` before the offline run; the executor surfaces a distinct actionable reason and the
  coverage counters make systematic non-execution visible. Gates 7–8 also *decline*
  (fail-safe) whenever mutability/data-dependence is AST-unresolvable, so real coverage is
  unknown until the Phase-2 spike measures it.
- **CANDIDATE PoCs are untrusted, un-executed model Solidity** whose asserted invariant may
  be wrong — the Phase-1 tier's label reads "CANDIDATE — generated, NOT executed,
  correctness AND relevance unverified; **run only in an isolated sandbox (offline,
  non-root); never against a checkout containing real secrets/keys** — the static gate is a
  best-effort scrub, not an execution-safety guarantee." Once the Phase-2 spike records
  generation pass/hollow rates, the README states them so operators calibrate trust in
  CANDIDATE output.

## §7 Build sequencing & the generation-spike GATE

The der-sc ROI PoC was **human-authored** (7 write→forge cycles to `4/4 PASS`), and no
generation spike has yet measured whether the **model** can author either tier. A
**local-deploy generation spike GATES the executor**, and — because v1 now ships two tiers —
it must exercise and grade **both** the static-bound (`CONFIRMED`) and harness-driven
(`POC_EXECUTED`) paths, with the false-accept gate applied to each:

- **Phase 1 (buildable now):** `poc-prompt.ts`, `poc.ts` (resolve + AST gates +
  `promoteWithPoc`), `pocModelCall`, the `--poc` generation-only tier (CANDIDATE attached;
  verdict does NOT move), §5 Phase-1 tests, backward-compatible wiring. **Phase 1 does NOT
  close #179** — it delivers a drafting aid, not a verdict change; a Phase-2 NO-GO keeps
  #179 open (or re-scopes it to "PoC-scaffold assist"), never closes it. Phase-1 PR
  title/body says "(Phase 1 of #179 — does not close it)".
  - **Phase-1 tier scope (descope 2026-09-02).** Since Phase 1 is generation-only (no
    executor → no promotion), the impl-audit soundness bar is scoped by tier:
    - **Tier-1 (`CONFIRMED`, static-bound) is the airtight promotable path** — its static
      gate must be 0 C/H/M (a hollow `CONFIRMED` is unacceptable). It is small and defensible:
      target-only instantiation, straight-line, closed-symbol + fabrication-surface guards, a
      view-only load-bearing assertion, decidable-tautology rejection.
    - **Tier-2 (`POC_EXECUTED`, harness-driven) is a BEST-EFFORT CANDIDATE classifier in
      Phase 1** — the gate classifies `tier:"harness-driven"` so a der-sc-style PoC is attached
      as a human-reviewable CANDIDATE, but it is **never promotable in Phase 1** and its static
      gate is explicitly best-effort (a hand-rolled static AST allowlist over arbitrary
      scaffolding code is an adversarially open surface). **Residual static-smuggling on the
      Tier-2 path is acceptable in Phase 1** (it cannot mint a verdict) and is **closed at
      Phase 3**, where the executor's runtime `-vvvv` trace (`targetFrameObserved` + build-info
      bytecode identity) co-validates the static gate — the trace, not the static AST scan, is
      the load-bearing guard for `POC_EXECUTED`. Hardening the Tier-2 static gate to airtight
      is therefore **deferred to the Phase-3 executor increment**, done alongside the trace
      co-validator rather than as an unbounded static-only exercise now.
  - **Focused Tier-1 re-audit (2026-09-02) — CONFIRMED path.** An iterated adversarial codex
    re-audit of the combined impl diff, scoped to the promotable path, drove the Tier-1 assertion
    gate to soundness. Each hollow-`CONFIRMED` vector was reproduced against the REAL classifier
    before fixing (codex fabricated its sample JSON repeatedly — always verify). The finding
    sequence was a single class (a decidably-constant / non-load-bearing assertion) in escalating
    spellings: annihilator/self-cancel + whole bitwise/boolean class; booleanized & negation/
    paren-laundered reflexive bounds; cast/identity/comparator-family self-comparison;
    offset-inequality; approx-eq tolerance; constant-folded self (`b + 5 - 5`); and arithmetic/
    width-dependent spellings of a type extreme (`type().max - 1 + 1`, `2 ** 256 - 1`,
    `~uint256(0)`, `uint256(int256(-1))`). Rather than patch spellings, the gate was rebuilt into
    the **two complete decision procedures of §3.3 gate 8** — the STRICT bare-vs-independent
    binding (closes the self-referential family) and `constTruth`+`foldConst` (a complete BigInt
    constant evaluator, closes every constant spelling) — plus approx-eq exclusion. **Lesson:
    when adversarial lanes keep finding the same class, stop patching instances and build the
    decision procedure; a Tier-1 assertion is one straight-line comparison of a target read, so
    the class is bounded and closable (unlike the Tier-2 scaffolding surface).** The wiring lane
    found **no Phase-1 blocker** (promotion gated behind `execution.executed`, `activeGo` honored,
    counters consistent, no static/harness tier-crossing). **Deferred to Phase 3** (not
    Phase-1-reachable — generation-only, no executor): (i) **trusted assertion-framework
    provenance** — a hostile audited repo could remap `forge-std/` to a no-op `assertEq`; the
    executor MUST source the assertion framework only from the pinned image and drop target
    remappings of it (spec'd in §3.4); (ii) an executor-enabled **non-terminal-render
    consistency** nit — `sweep.ts`/`run.ts` label an executed-but-unpromoted PoC generically
    without checking `executed` (harmless while `executePoc` is undefined); (iii) **Tier-2
    drive-receiver validation** — `classifyHarnessB4` accepts any top-level non-`vm`/non-assert
    call as the harness drive without resolving its receiver, so a `console2.log(...)` can be
    mislabeled the drive of a `revert`-form CANDIDATE. This is a Tier-2 CANDIDATE-quality issue,
    **trace-visible** (a logging "drive" yields no `drove`/`targetFrameObserved`, so the Phase-3
    trace co-validator rejects it — it can never mint a `POC_EXECUTED`), so it falls under the
    accepted Tier-2 static residual; Phase 3 should require the drive receiver to be a target var
    or §3.3.A scaffolding and exclude console/logging. **The full pre-merge 3-lane audit
    (2026-09-02) additionally fixed, on the Tier-1/shared surface:** an aliased-`Vm` fabrication
    surface (`import {Vm as X}` + `X(<hevm-addr, any spelling>).store(…)` — the fabrication guard
    now bans every local name bound to the forge-std `Vm` type, **trace-invisible so fixed not
    deferred**); abstract-contract mis-classification (parser emits `kind:"abstract"`); public
    state-variable + legacy `constant` getters not resolved as view reads; and executor-throw
    accounting (a thrown executor is a skipped-infra CANDIDATE, not a "generation failed" record).
- **Phase 2 (SPIKE GATE):** run the model **blind, finding-scoped** over an **unfiltered
  PURSUE sample** (not a curated local-deployable slice — so prevalence is measured, not
  assumed), graded by a human who did **not** have a reference PoC. **Committed
  `SPIKE_RESULT.json`** at a fixed committed path. **Every GO input is a per-finding typed
  field the validator recomputes — NO trusted top-level aggregate** (this closes the
  denominator/eligibility gaming the audit flagged):
  - `pursueSampleIds: string[]` — the exact unfiltered PURSUE finding ids drawn (the
    denominator is a manifest, not a scalar; `validate` requires **all `pursueSampleIds`
    distinct**, **all `findings[].id` distinct**, and a **bijection** — exactly one
    `findings` row per sampled id and vice versa (`findings.length ===
    pursueSampleIds.length` + set-equality alone is insufficient, since sets discard the
    duplicates that would otherwise inflate `eligible`/`confirmedEligible`/`prevalence`).
    Every count below is over this unique, bijective set.
  - `targets: [{ id, hasReferencePoc: boolean }]` — `validate` requires **all `targets[].id`
    distinct** and **every `findings[].targetId` resolves to exactly one `targets` row** (no
    orphan finding, and — see the shared GO predicate — target diversity is computed over the
    eligible rows' targets, so an orphan `targets` row cannot manufacture diversity).
  - `findings: [{ id, targetId, eligible: boolean, eligibleTier: "static-bound" |
    "harness-driven" | null, ineligibleClass: <§2-class|null>, attempted,
    **receipt: { target:{path,symbol}, staticGate:{passed}, tier, assertionForm, driveKind:
    "direct-revert" | "callback" | null, execution:{compiled, passed, deployedTargetPath,
    drove, targetFrameObserved} } | null**, humanConfirmedGenuine, acceptedHollow }]` —
    `eligible`/`eligibleTier`/`humanConfirmedGenuine`/`acceptedHollow` are the **human** grade
    (blind, independent of the model's decline); **`receipt` is the machine transcript emitted
    by the actual gate+executor run** for the finding (null if not attempted); `receipt.target`
    is the resolved `pocTarget` identity, and `driveKind` records whether a harness PoC drove
    the target **directly** (a direct `target.f()` that fell to Tier-2 only via a revert-form,
    `drove` may be true) or via a **callback** (`drove===false ∧ targetFrameObserved` — the
    genuine der-sc class). The validator **DERIVES** `gatePassed = receipt?.staticGate.passed
    === true`, `achievedTier = receipt?.tier ?? null`, `executed = receipt?.execution != null`,
    and **`promoted = wouldPromotePoc({poc: receipt, execution: receipt.execution}) !== null`** —
    the **GO-independent** terminal-evidence predicate (§3.3), NOT `promoteWithPoc` (which needs
    `activeGo`, the very thing the spike computes — circular). **It requires
    `receipt.execution.deployedTargetPath === receipt.target.path === pocTarget.path` (the
    finding's resolved target) and rejects the row otherwise** (so `wouldPromotePoc`'s identity
    check is decidable from the artifact, not inferred). It never trusts a raw `promoted`
    boolean; a row that omits `receipt` but claims genuineness → rejected. So a no-revert-only
    receipt has `promoted:false` even though executed, and a genuine harness receipt is
    `promoted:true` during the spike with no prior GO. Row-consistency (below) requires
    `eligible ⇔ eligibleTier !== null`, `gatePassed ⇒ achievedTier !== null`, and — the key
    anti-gaming rule — **every promoted row is classified exactly once:
    `promoted ⇒ (humanConfirmedGenuine XOR acceptedHollow)`** (a promoted row left in neither
    bucket is a validation error, not a free pass).
  `validateSpikeGoArtifact(artifact)` **derives every predicate over the ELIGIBLE subset
  `E = findings.filter(f => f.eligible)`, never a whole-array count, and ignores the
  artifact's own `verdict`** (ineligible rows can never offset missing eligible work or
  inflate a numerator). It first enforces **row-consistency invariants** — reject the
  artifact if any finding violates: `eligible ⇔ eligibleTier !== null`; `promoted ⇒
  (humanConfirmedGenuine XOR acceptedHollow)`; `humanConfirmedGenuine ⇒ eligible ∧ attempted ∧
  gatePassed ∧ executed ∧ promoted ∧ ¬acceptedHollow`; `acceptedHollow ⇒ eligible ∧ attempted
  ∧ gatePassed ∧ executed ∧ promoted ∧ ¬humanConfirmedGenuine`; `gatePassed ⇒ attempted ∧
  achievedTier !== null`; `executed ⇒ gatePassed`; `promoted ⇒ executed`. Then, over `E` and
  its per-tier partition `E_s = E.filter(eligibleTier==="static-bound")`, `E_h =
  E.filter(eligibleTier==="harness-driven")`: `pursueSampled = pursueSampleIds.length`;
  `eligible = |E|`; `prevalence = eligible / pursueSampled`; `acceptedHollow = count(f ∈
  findings where f.acceptedHollow)`. **Per-tier yield is keyed on the ACHIEVED tier, not just
  the eligible tier** (a harness-eligible row the gate minted as static-bound must not count
  as harness yield, and vice-versa):
  `confirmedStaticEligible = count(f ∈ E_s where humanConfirmedGenuine ∧ achievedTier==="static-bound")`;
  `pocExecutedHarnessEligible = count(f ∈ E_h where humanConfirmedGenuine ∧ achievedTier==="harness-driven")`.
  **GO is decided per tier — the spike enables each executor path independently** (a thin or
  failing tier never blocks the other, but also never ships unproven):
  - **(shared)** `pursueSampled ≥ 20`, `eligible ≥ 6`, **target diversity computed over the
    ELIGIBLE rows** — `distinct(E.map(f => f.targetId)).size ≥ 2` ∧ `∃ f ∈ E where
    targetById[f.targetId].hasReferencePoc === false` (an orphan `targets[]` row not referenced
    by any eligible finding can NOT satisfy this), `E.every(f => f.attempted)`, `acceptedHollow
    === 0` across BOTH tiers (a promoted-then-hollow row anywhere → NO-GO for BOTH),
    `artifact.offlineBuild.ok === true` (a declared top-level artifact field
    `offlineBuild: { targetId, ok: boolean }` recording that a real target's whole-project
    closure built offline; validated present, and its `targetId` must resolve to a `targets`
    row — for a harness-enabling GO it must be an `E_h` target), `prevalence ≥ 0.10`. Any
    shared failure → global NO-GO.
  - **(Tier-1 / `CONFIRMED` enable)** additionally: `|E_s| ≥ 3` ∧ `confirmedStaticEligible/|E_s|
    ≥ 0.30`.
  - **(Tier-2 / `POC_EXECUTED` enable)** additionally: `|E_h| ≥ 3` ∧ `pocExecutedHarnessEligible/|E_h|
    ≥ 0.30` ∧ **`pocExecutedHarnessEligible ≥ 1`** (at least one *genuine, human-confirmed,
    executed* harness `POC_EXECUTED` — a merely *eligible* `E_h` row that never gate-passed
    CANNOT). **The `≥ 1` genuine row must be a genuine CALLBACK PoC** — `receipt.driveKind ===
    "callback"` (`drove===false ∧ targetFrameObserved`), NOT a `"direct-revert"` row: #179 was
    born from the callback/hook class (der-sc), so a spike whose only harness yield is
    direct-target revert PoCs (nearly as strong as `CONFIRMED`, but not the callback path) has
    **not** proven the motivating class — `enableHarness` stays false and #179 stays open. der-sc
    is a valid such callback row. `|E_h|` is an **eligibility** count and never by itself enables
    the tier — the harness path is the new, weaker code and ships **only** on demonstrated
    non-hollow *callback* yield.
  - **The GO artifact records `enableStatic: boolean` and `enableHarness: boolean`** from the
    two tier gates, and **`validateSpikeGoArtifact` recomputes both from the per-finding array
    (via `wouldPromotePoc`-derived `promoted` + the per-tier yield gates) and rejects the
    artifact if a recorded flag disagrees with the recomputed value** (the flags are not
    trusted inputs). If neither enables → global NO-GO (ship Phase 1, keep #179 open). If only
    `enableStatic` → Phase 3 ships **`CONFIRMED`-only**; the harness executor path stays behind
    a dedicated follow-up harness spike, and `POC_EXECUTED` is never mintable until a later
    GO sets `enableHarness`. **A `enableStatic ∧ ¬enableHarness` Phase 3 does NOT close #179**
    — #179's re-scoped deliverable (§Goal) covers the harness/callback class (der-sc) via
    `POC_EXECUTED`, so a static-only increment leaves the motivating class unsolved: its PR
    title/body must say "Phase 3 static-only — harness/der-sc (#179) remains open," and **only
    a GO with `enableHarness===true` may close the re-scoped #179.**
- **Phase 3 (post-GO only):** `dockerPocExecutor` (§3.4) + execution wiring + terminal states,
  **each tier gated by its own `enable*` flag**; `SIDECAR_POC_EXEC` refuses to run unless
  `validateSpikeGoArtifact()` passes on the committed `SPIKE_RESULT.json` (schema-valid AND
  every predicate **recomputed** from the per-finding array — not merely `verdict==="GO"`), and
  `promoteWithPoc` refuses to mint `POC_EXECUTED` unless the active GO artifact has
  `enableHarness===true` (a `CONFIRMED`-only GO leaves harness findings at PURSUE). Then a
  **cross-model audit of the full executor diff** before enabling in any real run. Executor
  stays opt-in throughout.

### Residual hardening (post-v1, NOT gating) — content-hash pinning of §3.3.A

The §3.3.A anchor allowlists vendored scaffolding by **import specifier + real-dependency
path**, not by content hash (§1 residual (e), §6). A repo could therefore vendor a doctored
"`MockERC20`" under `lib/` that fabricates the asserted state; v1 catches this only by human
review of the PoC's imports (every `CONFIRMED`/`POC_EXECUTED` is human-gated). The named future
hardening is a **content-hash allowlist** of the specific vetted scaffolding sources
(`Deployers`, `MockERC20`, `HookMiner`, OZ mocks at pinned versions), rejecting a
same-path/same-specifier file whose bytes differ. This is a **hardening of an existing v1
gate, not a new lane** — it does not change what is eligible, only shrinks residual (e).
Deferred because it is brittle across dependency versions and the human gate already covers
the residual; it lands if a real target trips the specifier+path anchor.
