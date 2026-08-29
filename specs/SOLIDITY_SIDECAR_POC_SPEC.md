# Solidity sidecar — PoC generation + local-container verification (post-PURSUE)

Status: READY TO BUILD (Phase 1) — v8, converged to **zero critical/high/medium across all
five audit lanes** (3 codex + adversarial verificator + product critic) over eight rounds;
the verificator ACCEPTed and every lane's final pass returned clean. Build Phase 1 first;
the executor (Phase 3) is gated behind the §7 generation spike. · implements
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
(strong: direct-drive, statically bound) or the explicitly weaker **`POC_PASSED`**
(harness-driven, trace-proven; §1) — otherwise the finding **stays PURSUE with a reason**
(never demoted to DROP).

**#179 acceptance, in consumer terms (what Phase 3 closes and what it does not).** The
issue's pain is that the consumer must redo confirmation and cannot tell a true PURSUE
from a plausible-but-wrong one. This stage's Phase-3 deliverable is: *for an eligible
finding, an executed, deploy-verified (build-info ground-truth), human-reviewable PoC and a
terminal state — `CONFIRMED` for the direct-drive class, `POC_PASSED` for the harness/callback
class (der-sc) — that removes the LABOR of writing and running the scaffold.* It deliberately
does **not** remove the consumer's relevance judgment (§1 leaves "does this assertion capture
THIS bug" to the human, and for `POC_PASSED` also "was the target driven through the cited
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
- **No auto-submission, ever.** `CONFIRMED` and `POC_PASSED` are local, human-gated.
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
> **Tier 2 — `POC_PASSED` (weaker, harness-driven): "a passing forge test that deploys the
> real cited contract from source (same build-info ground truth) surrounded only by
> real-dependency-anchored allowlisted scaffolding (§3.3.A), whose `-vvvv` execution trace
> shows a call frame at the deployed target's address — i.e. the target's real bytecode
> executed under the test."** The target may be driven **indirectly** (through allowlisted
> harness such as `Deployers.swap` → real `PoolManager` → hook callback), and the assertion
> may be a post-drive target read, a `vm.expectRevert`-guarded drive, or (weakest, and so
> recorded) proof-by-absence-of-revert. HUMAN-GATED, run-specific, NEVER auto-published,
> and — because the trace proof IS the guarantee — **only reachable with execution (a
> Phase-3 outcome; there is no generation-only `POC_PASSED`)**. It does **not** claim a
> direct-drive assertion over the target's own state, and is NOT a proof of the exploit.

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
runtime target-frame trace proof** — a `POC_PASSED` is refused if the trace does not show the
target's bytecode executing.
**NOT enforced, left to the human** (so §1 does not overclaim): (a) that the assertion
captures *this* finding's bug vs. a true-yet-irrelevant property; (b) differential proof
against a corrected baseline; (c) an obfuscated cheatcode-address the scanner missed; (d)
an arbitrary literal address used where a real dependency is expected; (e) a vendored
dependency under `lib/`/`node_modules/` that *itself* fabricates the asserted state — the
§3.3.A anchor allowlists by import specifier + real-dependency path, **not** by content
hash, so a doctored vendored "mock" is caught only by human review of the PoC's imports
(v1 accepts this residual risk; content-hash pinning is a future hardening); (f) **for
`POC_PASSED` specifically**, that the harness drove the target through the *cited* path (the
trace proves the target executed, not that it executed the vulnerable branch) and, for a
proof-by-no-revert PoC, that the absence of revert is meaningful. Every `CONFIRMED` **and**
`POC_PASSED` object **always co-carries `humanGated:true` + `runSpecific:true`** in the same
record; the consumer-facing label is an atomic string per tier — Tier 1: *"CONFIRMED
(PoC-executed, human-review-required): deployed the real cited contract, drove it directly,
an assertion over its post-drive state passed — NOT a proof of the specific exploit."*;
Tier 2: *"POC_PASSED (harness-driven, human-review-required): a passing Foundry PoC deployed
the real cited contract from source and its bytecode executed under the test, but the target
was driven indirectly and/or the assertion is by-absence-of-revert — NOT a direct-drive
assertion and NOT a proof of the specific exploit."* There is **no
programmatic consumer of `verdict` in v1** (no auto-submission); the spec REQUIRES any
future programmatic consumer (a merge gate) to treat **neither** `verdict==="CONFIRMED"`
**nor** `verdict==="POC_PASSED"` as exploitability except in conjunction with `humanGated`,
and to never collapse the two tiers into one bucket (`POC_PASSED` ranks strictly below
`CONFIRMED`) — acceptance lines pin both.

## §2 Scope & non-goals

**In scope:** local-deploy Foundry PoC generation + local-container execution + the
`CONFIRMED` gate, for PURSUE findings — a **single asserted target** (the real cited
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
   revert-assertion immediately guarding a **drive call to the bound target** (§3.3 gate 8;
   der-sc PoC2/PoC4 rely on this — the inverted-cap buy MUST revert, draining MUST brick),
   with a selector required when the finding cites a specific error. An `expectRevert` that
   guards anything other than a bound-target drive is ineligible; reason "requires an
   unbound revert demonstration (out of v1 scope)".
7. **The patch/repro-verifier runner** (`apps/web/**`).
8. **Auto-submission / auto-publication / any bounty target as a fixture.**
9. **A GitHub-Actions execution backend** — the Docker executor sits behind a
   `PocExecutor` interface so Actions can replace it later with zero pipeline change.
10. **Finder/recall uplift** — this is a verification stage.

Non-goals 1–6 are the eligibility limiters — 1/4/5 exclude a class outright; 2/3/6 draw the
line *within* the harness tier (vendored-scaffolding-and-revert IN as `POC_PASSED`,
test-authored logic OUT). §4's report banner names them so a consumer never reads
absence-of-CONFIRMED/POC_PASSED as "checked and failed" for a class that was ineligible.

## §3 Data model & modules

### 3.1 New verdict + result fields (backward-compatible)

`ScoredFinding.verdict` extends to `"CONFIRMED" | "POC_PASSED" | "PURSUE" | "DROP"`; both
`CONFIRMED` (Tier 1, static-bound direct-drive) and `POC_PASSED` (Tier 2, harness-driven,
trace-proven) are reachable **only** from PURSUE, and each such record **always** carries
`poc.humanGated===true ∧ poc.runSpecific===true`. `poc.tier` ∈ `"static-bound" |
"harness-driven"` records which gate path minted it; `CONFIRMED` ⇒ `"static-bound"`,
`POC_PASSED` ⇒ `"harness-driven"`. All new fields are **optional and `undefined` when
`--poc` is off** (so `JSON.stringify` + the sweep `...result` spread omit them —
byte-identical, pinned by §5.1). `ScoredFinding.poc?` records `generated`, `rationale`,
`tier`, `target {path,symbol,kind:"contract",derivation}`, `binding` (§3.3 `PocBinding`;
`undefined` for the harness path, which has no static drive/assert binding), `testPath`,
`testContents`, `staticGate {passed,reasons}`, `executed`, `execution
{ranTests,passedTests,failedTests,skippedTests,compiled,passed,exitCode,summary,reason,
deployedTargetPath, drove, targetFrameObserved}`, `humanGated`, `runSpecific`.
`targetFrameObserved` is the §3.4 trace proof that a call frame executed at the deployed
target's address — **required truthy for `POC_PASSED`** (Tier 1 already has it implied by
the stronger static `drove` binding). `FinderRunResult` gains OPTIONAL `confirmedCount?`,
`pocPassedCount?`, `pocAttempted?`, `pocExecuted?`, `pocSkippedInfra?`. The Stage-B
focused-confirm model verdict (`"CONFIRMED"|"REVISED"|"REFUTED"`) is model-internal and
**MUST NEVER** map to `ScoredFinding.verdict`; only `promoteWithPoc()` after real execution
sets terminal `CONFIRMED`/`POC_PASSED` (regression test).

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
  never a hand-written fake the target consumes. The single `testAuditPoc` drives the target
  **through the real harness** (e.g. `swap(...)`) and asserts with **one** of: a
  `vm.expectRevert(<selector>)` guarding that drive; an `assert*` reading a real target member
  after the drive (strongest — prefer this); or, only if neither is expressible, a
  no-revert body (weakest — the runtime trace + human carry it). This is the der-sc H1/H2
  class (inverted epoch cap; dead band).
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
  - Contract creation: Tier-1 uses only plain `new <target|closure>(...)`; Tier-2 may also
    use `new pocTarget.symbol{salt:…}` with a `HookMiner`-mined salt. Bare
    `create/create2`/`type(X).creationCode` assembly is forbidden on both.
  - `assert*` must be forge-std `Test`/`StdAssertions` (or built-in `assert`). Tier-1
    forbids `assertTrue(true)`/constant-only/deployment-only assertions; Tier-2 permits a
    no-revert body **only** as a last resort (prefer a real target read or a selector-qualified
    `expectRevert`).
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
target deploy, or a revert/no-revert assertion) — and nothing in the **hard invariants
below** is violated — it falls through to the **Tier-2 harness path (§3.3.B)**. A PoC that
violates a hard invariant DECLINES to PURSUE on **both** paths (no silent downgrade past a
fabrication check).

**Hard invariants (BOTH tiers — a violation is a decline, never a tier downgrade):** the
cheatcode/exfil denylist (gate 2, minus the CREATE2/salt carve-out below), the funding-cheat
constraint (gate 3: only `vm.deal(EOA,uint256)`; never `deal(token,…)`/`stdstore`/`vm.sign`),
**no repo-/test-authored logic contract** (§3.3.A), size (gate 4), and the build-info
ground-truth target identity (§3.4, enforced at execution). The Tier-2 relaxation is
*structural only* (shape + binding), never a relaxation of what may fabricate state.

**§3.3.A — real-dependency anchor (the harness allowlist).** Every contract *instantiated*
in the test (`new X`, `new X{salt:…}`, or a base the test `is`) must be exactly one of:
(a) **the cited target** `pocTarget.symbol` from `pocTarget.path`; or (b) **allowlisted
vendored scaffolding** — its symbol resolves, through the test's imports (`import {Sym as
Alias}` handled), to BOTH a **known import specifier** on the pinned allowlist
(`forge-std/*`; `@uniswap/v4-core/test/utils/*` incl. `Deployers`; `@uniswap/v4-periphery/`
`…/HookMiner`; solmate `…/test/utils/mocks/MockERC20`; OpenZeppelin `…/mocks/*`) **and** a
resolved file path under a **real-dependency root** (`lib/**` or `node_modules/**`), never
the repo's own `src/`/`test/`/`script/`. Anything instantiated that is not (a) or (b) — a
`contract`/`library` **declared in the test file**, a symbol from a repo-authored path, or a
symbol from an unknown specifier — **declines to PURSUE** ("requires a test-authored
contract" / "unrecognized scaffolding `<spec>`"). The allowlist is a pinned constant with a
CI drift test; adding an entry is a spec change. This anchor is what separates *benign
vendored fixtures* (der-sc's `Deployers`/`MockERC20`) from *author-fabricated state* — the
latter can never pass, on either tier.

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
6. **No fabrication / no mock dependency** — the test declares no contract/library/
   interface except the test contract; **every `new X` binds to `pocTarget.symbol` or a
   contract declared in a cited closure path** — never a mock (test-authored OR
   sidecar-provided; there is no scaffold in v1), never an arbitrary literal address used
   where a dependency contract is expected (residual §6).
7. **Drive-binding** — a statement `binding.deployedVar.<f>(…)` (or value transfer) where
   `<f>` resolves — through `pocTarget`'s **inheritance linearization** over
   `closureAstByPath` — to a **non-view, non-pure** function, appearing before the asserted
   read. Unresolved mutability → decline.
8. **Assertion-binding** — ≥1 `assert*` whose operand data-depends (through straight-line
   local assignments) on a read `binding.deployedVar.<g>(…)` whose statement is **after**
   the drive statement. Reject constant-only, deployment-only, pre-drive reads.

**Tier-2 harness path (§3.3.B) — mints `POC_PASSED`** (only when gates 1/7/8 fail *for
shape reasons* while every §3.3.A hard invariant holds). The harness path CANNOT bind the
target statically (der-sc drives the hook through a real `PoolManager` callback, not a
direct `target.f()`), so its soundness is **deferred to the §3.4 runtime trace** — a
`POC_PASSED` is impossible without execution. Static gates on this path:
- **B1. Contract set** — one test contract that may `is Test[, <§3.3.A base>]`, may declare
  `setUp()` + helper functions, and may contain control flow **anywhere** (setup realism).
  Every instantiated symbol satisfies §3.3.A (this is the load-bearing check). No
  `pocTarget.symbol` may be *declared* in the test file (only imported from `pocTarget.path`).
- **B2. Hard invariants** — the gate-2 denylist (with the CREATE2/salt carve-out), gate-3
  funding constraint, and gate-4 size all hold, evaluated over the **whole file** (setUp +
  helpers + tests), exactly as Tier-1. `deal(token,…)`/`stdstore`/`etch`/`store`/`mockCall*`/
  `vm.sign` ⇒ decline.
- **B3. Target-import present** — `pocTarget.symbol` is imported from a path canonicalizing
  to `pocTarget.path` and is instantiated at least once (`new`/`new{salt}`); else decline
  ("no deployable cited target").
- **B4. Assertion shape** — exactly one test function `testAuditPoc()` containing **≥1 of**:
  (i) a `vm.expectRevert(<selector?>)` immediately followed by a call/`swap`-style drive
  (revert-assertion; selector REQUIRED when the finding cites a named error), (ii) an
  `assert*` reading a target member (`pocTarget.symbol` instance `.<g>()` — a real read,
  the strongest harness form), or (iii) a bare `assertTrue(<literal true>)`/no-revert body
  **flagged `weakAssertion:"no-revert"`** (admitted, but the §3.4 trace proof and human gate
  carry it). A test with none of (i)–(iii) declines. `poc.assertionForm ∈
  {"revert","target-read","no-revert"}` is recorded.
- **B5. No static binding emitted** — `binding` is `undefined`; `tier:"harness-driven"`.

**`promoteWithPoc({base, poc}) → {verdict, reason}`:** `base.verdict !== "PURSUE"` →
return `base`.
- **`CONFIRMED`** iff `poc.tier==="static-bound" ∧ staticGate.passed ∧ executed ∧ compiled
  ∧ passed ∧ execution.deployedTargetPath === pocTarget.path ∧ execution.drove`.
- **`POC_PASSED`** iff `poc.tier==="harness-driven" ∧ staticGate.passed ∧ executed ∧
  compiled ∧ passed ∧ execution.deployedTargetPath === pocTarget.path ∧
  execution.targetFrameObserved` (the §3.4 non-static target-address frame — satisfied by an
  indirect/callback frame). **No `POC_PASSED` without execution** (a generation-only run
  leaves the harness PoC at PURSUE with reason "harness PoC awaiting execution").
- Else **PURSUE** with the specific reason (declined / static-gate / not-executed /
  deps-unavailable / did-not-compile / assertion-did-not-hold / target-path-mismatch /
  no-target-frame / executor-error / generation-failed / requires-live-fork /
  requires-test-authored-contract / requires-test-authored-dependency /
  unrecognized-scaffolding / harness-awaiting-execution). **Never DROP.**

### 3.4 `poc-executor.ts` — `PocExecutor` interface + `dockerPocExecutor`

`execute({targetRoot, testContents, binding, pocTarget, timeoutMs}) → PocExecResult`
(`{executed,compiled,passed,drove,targetFrameObserved,deployedTargetPath,ranTests,
passedTests,failedTests,skippedTests,exitCode,summary,reason}`). `binding` is `undefined`
on the harness path (no static drive/assert spans); the executor then relies on
`targetFrameObserved` alone. `dockerPocExecutor` (env-gated `SIDECAR_POC_EXEC=1`
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
- **`drove` / `targetFrameObserved`** = the `-vvvv` call trace shows a **non-STATICCALL**
  frame at that same deployed target **address** (from the step above) **after** its
  CREATE/CREATE2. `drove` (Tier-1) additionally requires the frame to be a **direct** call
  from the test contract — the statically bound `binding.driveSpan`; `targetFrameObserved`
  (Tier-2) is the weaker, **binding-free** predicate: the frame may be reached **indirectly**
  (e.g. `swapRouter → PoolManager → hook.beforeSwap` shows a non-static frame at the hook
  address), which is exactly why `POC_PASSED` ranks below `CONFIRMED`. A trace with the
  target address appearing **only** under STATICCALL, or not at all, sets both false → the
  harness PoC stays PURSUE ("no-target-frame"). `assertionExecuted` is **not** a trace check
  on either tier — Tier-1's straight-line gate + forge PASS guarantees the unconditional
  assertion executed; Tier-2's single `testAuditPoc` + forge PASS (with the §3.4 summary-count
  parse) guarantees its assertion ran (a reverting `expectRevert` body that did not reach the
  guarded drive would fail the test, not pass it).
- **solc offline**: uncached solc under `--network none` → `compiled:false,
  reason:"deps unavailable"` → PURSUE.
- **Redaction**: bounded trace/summary tail, `console.log` + secret/`0x`-key tokens
  stripped. Remove scratch in `finally`.

### 3.5 `model-client.ts` — `pocModelCall`

`pocModelCall(prompt, options?)` defaulting to `CONFIRM_DEFAULT_MODEL` (`gpt-5.5`;
`SIDECAR_POC_MODEL` override). Malformed JSON/transport/timeout → surfaced as a
generation failure (never a crash that loses the finding — §4).

## §4 Wiring

- `run.ts` `runFinder(input, callFinder?, refute?, confirm?, generatePoc?, executePoc?)` —
  new callbacks appended after `confirm`. After the scoring loop, for each
  `verdict==="PURSUE"` with `generatePoc` present, in a **per-finding try/catch** (a throw
  → PURSUE with reason, finding preserved): `resolvePocTarget` → generate →
  parse+`staticGatePoc` (returns `tier`) → (if gate passed ∧ `executePoc` present) execute
  (passing `binding` when `tier==="static-bound"`, else `undefined`) → `promoteWithPoc`
  (three-way: `CONFIRMED` / `POC_PASSED` / PURSUE). A `harness-driven` gate-pass with no
  `executePoc` stays PURSUE ("harness-awaiting-execution"). Absent callbacks leave the loop
  + output unchanged.
- `sweep.ts` `auditEntry` gains `poc: boolean`; when `live && poc` composes `generatePoc`
  (`pocModelCall`) + `executePoc` (`dockerPocExecutor`). **Consumer surface:** renderers
  add PoC sections only when ≥1 finding carries a `poc`; each renders its own atomic §1 tier
  label (`CONFIRMED` and `POC_PASSED` shown as **distinct** rows, never summed); **severity
  and confirmation are orthogonal — neither CONFIRMED nor POC_PASSED is ever reordered above
  a higher-severity PURSUE, and POC_PASSED is never rendered as/above CONFIRMED**; a top
  banner states "CONFIRMED = direct-drive static-bound proof; POC_PASSED = harness-driven,
  trace-proven, weaker (indirect drive and/or no-revert); both are human-review-required and
  local-deploy only; absence does not lower severity — these classes still cannot earn either:
  live fork, test-authored attacker/dependency, token-balance-dependent (ETH-only funding),
  and signature-dependent" and a coverage line "executor ran on X/Y eligible findings (Z
  skipped: deps-unavailable / executor-off / class-ineligible)". PURSUE reasons distinguish
  class-ineligible vs **assertion-did-not-hold** (neither exoneration nor confirmation — a
  one-line note says so) vs **no-target-frame** vs infra. Update **both** `buildPursueMarkdown`
  **and** `buildDedupedPursueMarkdown` (both filter `verdict==="PURSUE"` today and would drop
  `CONFIRMED`/`POC_PASSED` — both must roll up as non-PURSUE). `SweepEntryOutcome`/
  `SweepSummary.totals` gain `confirmed`, `pocPassed`, `pocAttempted`, `pocExecuted`,
  `pocSkippedInfra`.
- `cli.ts`: `--poc` (single + sweep), honored only with `--live`. Usage/README document it,
  `SIDECAR_POC_EXEC`, the GO-artifact requirement, the local-deploy scope, the ceiling.
- `README.md`: replace the "nothing executes a PoC / Foundry lane parked" text; add the
  opt-in stage, ceiling, §7 spike gate, and the CANDIDATE label (below).

## §5 Acceptance criteria & tests (split by build phase — §7)

**Phase-1 (generation-only; buildable now):**
1. `pnpm typecheck` clean; `pnpm vitest run src/sidecar-solidity` green — existing suites
   untouched; **no-`--poc` `--live` output byte-identical**, pinned by an exact-bytes
   fixture covering **the sweep JSON path** (assert `confirmedCount` etc. absent, not `0`).
2. `poc.test.ts` (AST gates, pure). Each rejected: `vm.store`, `vm . etch`,
   `vm./**/mockCall`, `"/*"`-in-string hiding `vm.etch`, `Vm z=vm; address(z).call(...)`,
   `abi.encodeWithSignature("etch...")`, `bytes4(keccak256("store(...)"))`,
   `stdstore.checked_write(...)`, bare/inherited `deal(token,addr,x)` and the 3-arg
   overload, **`vm.deal(address(target), x)` / `vm.deal` to a deployed-contract instance**,
   `vm.sign(...)`, `vm.expectRevert(...)`, `assembly{ create2(...) }` /
   `type(X).creationCode`, a bespoke `contract Fake`, an `import {Target as T}` +
   same-basename-different-path stub, a non-`.sol`/out-of-allowlist import, a body with a
   ternary/`if`/`for`/early-`return`, a fake local `function assertEq(...)` helper, a
   view-only drive, a pre-drive read, a deployment-only assertion. Each **accepted**:
   `vm.prank`/`vm.startPrank`/`vm.stopPrank`, `vm.deal(addr,uint)` (2-arg), `vm.warp`,
   `vm.roll`. A valid straight-line deploy→(optional warp)→non-view-drive→post-drive-read→
   assert PoC passes with `tier:"static-bound"` and yields a `PocBinding`.
   **Tier-2 (§3.3.A/§3.3.B) cases:** a harness PoC — `contract AuditPoc is Test, Deployers`
   with `setUp()` (control flow allowed), a `new Target{salt:HookMiner.find(...)}` deploy,
   an indirect `swap(...)` drive, and a selector `vm.expectRevert(Target.Err.selector)` —
   passes with `tier:"harness-driven"`, `binding:undefined`. **Declines** (hard-invariant
   or §3.3.A): a harness PoC that declares its own `contract FakeOracle`; one importing a
   **repo-authored** (`src/`/`test/`) mock; one importing an **unknown-specifier** base; a
   `new X{salt:0x123}` with a non-`HookMiner` literal salt; a harness PoC using
   `deal(token,…)`/`stdstore`/`vm.sign`. A harness PoC whose only assertion is
   `assertTrue(true)` passes the gate but is recorded `assertionForm:"no-revert"`.
   `resolvePocTarget`: interface/library-only → decline; multi-entry ambiguity → decline.
   `promoteWithPoc` truth table (three-way): **CONFIRMED** only when `tier==="static-bound"
   ∧ staticGate ∧ executed ∧ compiled ∧ passed ∧ deployedTargetPath===pocTarget.path ∧
   drove`; **POC_PASSED** only when `tier==="harness-driven" ∧ staticGate ∧ executed ∧
   compiled ∧ passed ∧ deployedTargetPath===pocTarget.path ∧ targetFrameObserved`; a
   `harness-driven` gate-pass with `executed:false` → PURSUE ("harness-awaiting-execution");
   every other combo → PURSUE-with-reason; a `CONFIRMED` **or** `POC_PASSED` record always
   has `humanGated ∧ runSpecific`, and `POC_PASSED` never sets `tier:"static-bound"`.
3. `poc-prompt.test.ts`: prompt names `pocTarget`; describes **both** tiers (prefer
   static-bound; harness fallback for callback targets); forbids the full denylist + flags +
   **self-declared** contracts + assembly + forge-std fabrication wrappers + `vm.sign`;
   lists the §3.3.A scaffolding allowlist and the `HookMiner`-salt carve-out; defines the
   decline shape (revert/callback are NOT declines).
4. `run.test.ts`: injected fakes — PURSUE + static-bound gate + passing fake exec
   (path-match + drove) → CONFIRMED; PURSUE + harness-driven gate + passing fake exec
   (path-match + targetFrameObserved) → POC_PASSED; harness-driven gate with NO `executePoc`
   → PURSUE ("harness-awaiting-execution"); gate-failed / target-path-mismatch / no-drive /
   no-target-frame / assertion-failed / declined → PURSUE; thrown `executePoc` → PURSUE;
   DROP untouched; Stage-B `"CONFIRMED"` never terminal; no bare `verdict==="CONFIRMED"` or
   `"POC_PASSED"` without `humanGated` in any rendered/serialized path; the sweep renderer
   shows CONFIRMED and POC_PASSED as distinct rows and never sums them.
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
   real target and drives it via an intermediary so the target executes only as an
   **indirect callback** → `targetFrameObserved:true` ∧ `drove:false` → **POC_PASSED** (the
   canonical der-sc shape); a fixture whose target address appears in the trace **only under
   STATICCALL** → `targetFrameObserved:false` → PURSUE ("no-target-frame"); a `CREATE2`
   mined-salt target deploy → the bytecode→artifact match still binds `deployedTargetPath`
   (proves CREATE2 handling). Plus a `validateSpikeGoArtifact` unit test with a
   negative fixture per GO predicate (incl. a schema-valid `verdict:"GO"` whose recomputed
   predicates fail → rejected; an artifact faking yield by marking **ineligible** rows
   `humanConfirmedGenuine`/`attempted` → rejected by the eligible-subset recompute; a
   row-consistency violation such as `humanConfirmedGenuine ∧ ¬executed` → rejected; and a
   **duplicate-id** artifact repeating one confirmed eligible id across `pursueSampleIds`/
   `findings` to inflate the denominator → rejected by the uniqueness/bijection check).
9. A real-target **offline whole-project build** completes within the timeout on the
   Phase-2 targets.

## §6 Risks & honest limits

- **Neither tier is proof** (§1). `CONFIRMED` = "real target deployed (build-info verified)
  + **direct** non-static drive + post-drive assertion executed"; `POC_PASSED` = "real
  target deployed (build-info verified) + its bytecode executed in the trace (possibly via
  callback) under a passing test" — NOT that the assertion captures *this* bug, and for
  `POC_PASSED` not even that the target was driven directly. Both are human-gated,
  run-specific; the machine token always co-carries `humanGated`, and the two tiers are
  never merged.
- **Residual fabrication surface (accepted, human-gated):** an obfuscated cheatcode-address
  the scanner misses; an arbitrary literal address supplied where a real dependency is
  expected; a true-yet-irrelevant assertion; **and, newly admitted with the harness tier,**
  a vendored dependency under `lib/`/`node_modules/` that itself fabricates the asserted
  state (the §3.3.A anchor allowlists by import specifier + real-dependency path, not by
  content hash) and a `POC_PASSED` whose harness drove the target but not through the
  *cited* vulnerable branch. The **no-repo/test-authored-logic-contract** invariant (§3.3.A)
  still closes the bespoke-fake and author-written-mock vectors on both tiers — that line,
  not "no scaffolding at all", is the fabrication floor. Content-hash pinning of the
  allowlist is the named future hardening.
- **Coverage — two tiers, honestly ranked.** The strong `CONFIRMED` tier stays narrow:
  single-target, **direct-drive**, local-deploy — access-control, re-initialization,
  ETH/parameter accounting, where a plain deploy-and-call PoC suffices. The `POC_PASSED`
  tier extends reach to the **harness/callback class** — Uniswap-v4 hooks and other
  contracts a real router/manager drives — **which is exactly the der-sc class that
  motivated #179**: der-sc's human PoC (`test/AuditPoC.t.sol`, re-run 2026-08-29, `4/4
  PASS`) deploys the real `RelativeIndexHook` and proves H1/H2 through a real `PoolManager`,
  and now lands as `POC_PASSED`. Still ineligible on **both** tiers (stay PURSUE): live
  fork, a **test-authored** attacker or hand-written substituted dependency, token-balance-
  dependent (ETH-only funding), signature-dependent (§2). Actual per-tier prevalence in an
  unfiltered PURSUE population is unknown until the Phase-2 spike measures it (§7); the spike
  must sample **both** an eligible direct-drive subset and the harness subset (der-sc is a
  valid harness-subset target); the banner states absence of either tier does not lower
  severity.
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
(`POC_PASSED`) paths, with the false-accept gate applied to each:

- **Phase 1 (buildable now):** `poc-prompt.ts`, `poc.ts` (resolve + AST gates +
  `promoteWithPoc`), `pocModelCall`, the `--poc` generation-only tier (CANDIDATE attached;
  verdict does NOT move), §5 Phase-1 tests, backward-compatible wiring. **Phase 1 does NOT
  close #179** — it delivers a drafting aid, not a verdict change; a Phase-2 NO-GO keeps
  #179 open (or re-scopes it to "PoC-scaffold assist"), never closes it. Phase-1 PR
  title/body says "(Phase 1 of #179 — does not close it)".
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
  - `targets: [{ id, hasReferencePoc: boolean }]`.
  - `findings: [{ id, targetId, eligible: boolean, eligibleTier: "static-bound" |
    "harness-driven" | null, ineligibleClass: <§2-class|null>, attempted, gatePassed,
    achievedTier: "static-bound" | "harness-driven" | null, executed,
    humanConfirmedGenuine, acceptedHollow }]` — `eligible` and `eligibleTier` are graded by
    the **same blind human**, **independent of the model's own decline** (a model
    under-declining cannot inflate them); `achievedTier` is the tier `staticGatePoc` minted
    (null if the gate declined). Row-consistency (below) requires `eligible ⇔ eligibleTier
    !== null` and `gatePassed ⇒ achievedTier !== null`.
  `validateSpikeGoArtifact(artifact)` **derives every predicate over the ELIGIBLE subset
  `E = findings.filter(f => f.eligible)`, never a whole-array count, and ignores the
  artifact's own `verdict`** (ineligible rows can never offset missing eligible work or
  inflate a numerator). It first enforces **row-consistency invariants** — reject the
  artifact if any finding violates: `eligible ⇔ eligibleTier !== null`; `humanConfirmedGenuine
  ⇒ eligible ∧ attempted ∧ gatePassed ∧ executed ∧ ¬acceptedHollow`; `acceptedHollow ⇒
  eligible ∧ attempted ∧ gatePassed ∧ executed ∧ ¬humanConfirmedGenuine`; `gatePassed ⇒
  attempted ∧ achievedTier !== null`; `executed ⇒ gatePassed`. Then, over `E` and its
  per-tier partition `E_s = E.filter(eligibleTier==="static-bound")`, `E_h =
  E.filter(eligibleTier==="harness-driven")`: `pursueSampled = pursueSampleIds.length`;
  `eligible = |E|`; `confirmedEligible = count(f ∈ E where f.humanConfirmedGenuine)`;
  `acceptedHollow = count(f ∈ findings where f.acceptedHollow)`; `prevalence = eligible /
  pursueSampled`. GO iff ALL:
  - (a) `pursueSampled ≥ 20` and `eligible ≥ 6` across `≥ 2` distinct targets with `≥ 1`
    `hasReferencePoc:false`; **and both tiers are exercised — `|E_h| ≥ 1` AND `|E_s| ≥ 1`**
    (the harness path is new code and must not ship unmeasured; der-sc is a valid `E_h`
    target, and its `test/AuditPoC.t.sol` counts as `hasReferencePoc:true` for that row).
  - (b) **`E.every(f => f.attempted)`** (`eligible ⊆ attempted`) AND **each non-empty tier
    clears yield independently**: `confirmedEligible/|E_s| ≥ 0.30` when `|E_s| ≥ 3`, and
    `pocPassedEligible/|E_h| ≥ 0.30` when `|E_h| ≥ 3` (`pocPassedEligible = count(f ∈ E_h
    where f.humanConfirmedGenuine)`; a tier with `< 3` eligible is exercised-but-not-yield-
    gated, so a thin tier can't block GO yet can't fake yield either).
  - (c) **`acceptedHollow === 0` across BOTH tiers** — acceptedHollow = PoCs that passed all
    gates + executed + promoted (to `CONFIRMED` **or** `POC_PASSED`) yet a blind human judges
    hollow; any `> 0` → NO-GO (fix gates, re-spike). The harness tier's weaker binding makes
    this gate the load-bearing soundness check for `POC_PASSED`.
  - (d) `offlineBuildOk` on a real target (**including one `E_h` target — the harness
    closure, e.g. v4-core, must build offline**).
  - (e) **`prevalence ≥ 0.10`**. **NO-GO → ship Phase 1, keep #179 open, do not build the
    executor.**
- **Phase 3 (post-GO only):** `dockerPocExecutor` (§3.4) + execution wiring + terminal
  `CONFIRMED`/`POC_PASSED`; `SIDECAR_POC_EXEC` refuses to run unless
  `validateSpikeGoArtifact()` passes on the committed `SPIKE_RESULT.json` (schema-valid AND
  every predicate **recomputed** GO from the per-finding array — not merely `verdict==="GO"`).
  Then a **cross-model audit of the full executor diff** before enabling in any real run.
  Executor stays opt-in throughout.

### Residual hardening (post-v1, NOT gating) — content-hash pinning of §3.3.A

The §3.3.A anchor allowlists vendored scaffolding by **import specifier + real-dependency
path**, not by content hash (§1 residual (e), §6). A repo could therefore vendor a doctored
"`MockERC20`" under `lib/` that fabricates the asserted state; v1 catches this only by human
review of the PoC's imports (every `CONFIRMED`/`POC_PASSED` is human-gated). The named future
hardening is a **content-hash allowlist** of the specific vetted scaffolding sources
(`Deployers`, `MockERC20`, `HookMiner`, OZ mocks at pinned versions), rejecting a
same-path/same-specifier file whose bytes differ. This is a **hardening of an existing v1
gate, not a new lane** — it does not change what is eligible, only shrinks residual (e).
Deferred because it is brittle across dependency versions and the human gate already covers
the residual; it lands if a real target trips the specifier+path anchor.
