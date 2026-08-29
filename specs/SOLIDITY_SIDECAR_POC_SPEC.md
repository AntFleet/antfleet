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

**Scope caveat — der-sc itself is OUT of the strict Phase-1 eligible class (measured
2026-08-29).** der-sc is a Uniswap-v4 hook; its human PoC (`test/AuditPoC.t.sol`) is
`contract AuditPoC is Test, Deployers` with 4 test functions, a `PoolManager` harness,
and `MockERC20` currencies — every one of those is forbidden by the §3.3 gates
(non-forge-std base, multi-function, mock dependencies). Running that PoC through
`staticGatePoc` rejects it at the first gate. So der-sc's bug class is **harness-
dependent** (§2.2/§2.3): its proof needs a multi-contract test fixture the sound gates
exclude. The ROI motivator is therefore in the *harder* class; the strict v1 targets the
narrower **single-contract, mock-free, EOA-drivable** class (access-control, re-init,
ETH/parameter accounting). Supporting harness-dependent bugs is a deferred increment with
a real trade-off (§7).

## Goal

An **optional, strictly post-PURSUE** stage that (1) **generates** a minimal
local-deploy Foundry test targeting the cited lines, driven by
`triggerRole`/`preconditions`; (2) **executes** it in a local Docker `--network none`
sandbox (a separate driver, never the patch-verifier runner); (3) promotes to a new
terminal state **`CONFIRMED`** only when the PoC executes and demonstrates the failure
under the §3.3/§3.4 gates — otherwise the finding **stays PURSUE with a reason** (never
demoted to DROP).

**#179 acceptance, in consumer terms (what Phase 3 closes and what it does not).** The
issue's pain is that the consumer must redo confirmation and cannot tell a true PURSUE
from a plausible-but-wrong one. This stage's Phase-3 deliverable is: *for an eligible
finding, an executed, deploy-verified (build-info ground-truth), human-reviewable PoC and
a terminal `CONFIRMED` state that removes the LABOR of writing and running the scaffold.*
It deliberately does **not** remove the consumer's relevance judgment (§1 leaves "does
this assertion capture THIS bug" to the human), and it applies only to the eligible class
(§2). #179 is therefore re-scoped from "confirm exploitability" to "produce a
human-reviewable executed+deploy-verified PoC and a terminal state for the eligible
local-deploy class"; closing it requires stating this re-scope on the Phase-3 PR, not
implying trust-without-review.

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
- **No auto-submission, ever.** `CONFIRMED` is local, human-gated.
- **Cost discipline.** Generation uses `model-client.ts`; no new HTTP client; no Neon
  branch; no DB. One new dependency permitted: a Solidity parser
  (`@solidity-parser/parser`) for the AST gates.
- **Sidecar boundary.** `git diff --stat` touches only `src/sidecar-solidity/**`,
  `package.json`, spec/docs.

## §1 The soundness ceiling (the label states it verbatim)

Prior Foundry-execution builds were rejected **twice** for minting a **hollow** verdict.
The standing DECISION (`antfleet-foundry-lane-descope-spike-gate`) we adopt:

> **`CONFIRMED` = "a forge test that deploys the real cited contract from source
> (verified by forge build-info), makes a non-static call to it (the DRIVE), and then
> executes an assertion that reads that same target instance after the drive,"
> HUMAN-GATED, run-specific, NEVER auto-published.** Not a claim of "provably THE exploit."

**Mechanically enforced** (§3.3 AST gates + §3.4 build-info + runtime trace): the
deployed target's source path equals `pocTarget.path` (forge build-info ground truth —
not a re-derived TS resolver); a straight-line test body; a non-static drive call to the
single bound target instance; a post-drive assertion reading that instance; no
fabrication cheatcodes / no forge-std state-fabrication wrappers / no assembly / no
contract creation except the target and real closure contracts; imports symbol-allowlisted.
**NOT enforced, left to the human** (so §1 does not overclaim): (a) that the assertion
captures *this* finding's bug vs. a true-yet-irrelevant property; (b) differential proof
against a corrected baseline; (c) an obfuscated cheatcode-address the scanner missed; (d)
an arbitrary literal address used where a real dependency is expected. Every `CONFIRMED`
object **always co-carries `humanGated:true` + `runSpecific:true`** in the same record;
the consumer-facing count/label is the atomic string *"CONFIRMED (PoC-executed,
human-review-required): deployed the real cited contract, drove it, an assertion over its
post-drive state passed — NOT a proof of the specific exploit."* There is **no
programmatic consumer of `verdict` in v1** (no auto-submission); the spec REQUIRES any
future programmatic consumer (a merge gate) to treat `verdict==="CONFIRMED"` as
exploitability only in conjunction with `humanGated` — an acceptance line pins this.

## §2 Scope & non-goals

**In scope:** single-target local-deploy Foundry PoC generation + local-container
execution + the `CONFIRMED` gate, for PURSUE findings.

**Non-goals (explicit — each keeps the finding PURSUE with the stated reason):**

1. **Live-fork PoCs** — reason "requires live fork (out of PoC v1 scope)".
2. **Multi-contract / attacker-contract PoCs** (reentrancy/callback/flash-loan needing a
   test-authored attacker) — v1 forbids ALL test-authored contracts (§3.3 gate 6);
   reason "requires multi-contract PoC (out of v1 scope)".
3. **Substituted-dependency PoCs** — a finding whose repro needs a *mock* dependency
   (fake oracle/token/router) the target consumes cannot be locally CONFIRMED (no mock,
   test-authored **or** sidecar-provided, may be a target dependency — §3.3 gate 6);
   reason "requires a substituted dependency (out of v1 scope)".
4. **ERC20-balance-fabrication PoCs** — the only funding cheat allowlisted is ETH via
   `vm.deal(address,uint256)` (§3.3 gate 3); `deal(token,…)` writes a token balance slot
   (fabrication) and is forbidden, so a bug that only triggers once an actor holds a
   token balance is ineligible; reason "requires token-balance setup (out of v1 scope)".
5. **Signature-dependent PoCs** — `vm.sign` is not allowlisted, so signature-replay /
   nonce / permit bugs are ineligible; reason "requires signature setup (out of v1 scope)".
6. **Revert-demonstration PoCs** — `vm.expectRevert` is not allowlisted (it changes the
   assertion model of §3.3 gate 8); a bug proven by "this call reverts when it must not"
   is ineligible in v1; reason "requires revert demonstration (out of v1 scope)".
7. **The patch/repro-verifier runner** (`apps/web/**`).
8. **Auto-submission / auto-publication / any bounty target as a fixture.**
9. **A GitHub-Actions execution backend** — the Docker executor sits behind a
   `PocExecutor` interface so Actions can replace it later with zero pipeline change.
10. **Finder/recall uplift** — this is a verification stage.

Non-goals 1–6 are the eligibility limiters; §4's report banner names them so a consumer
never reads absence-of-CONFIRMED as "checked and failed" for a class that was ineligible.

## §3 Data model & modules

### 3.1 New verdict + result fields (backward-compatible)

`ScoredFinding.verdict` extends to `"CONFIRMED" | "PURSUE" | "DROP"`; `CONFIRMED`
reachable **only** from PURSUE, and a `CONFIRMED` record **always** carries
`poc.humanGated===true ∧ poc.runSpecific===true`. All new fields are **optional and
`undefined` when `--poc` is off** (so `JSON.stringify` + the sweep `...result` spread omit
them — byte-identical, pinned by §5.1). `ScoredFinding.poc?` records `generated`,
`rationale`, `target {path,symbol,kind:"contract",derivation}`, `binding` (§3.3
`PocBinding`), `testPath`, `testContents`, `staticGate {passed,reasons}`, `executed`,
`execution {ranTests,passedTests,failedTests,skippedTests,compiled,passed,exitCode,
summary,reason, deployedTargetPath, drove}`, `humanGated`, `runSpecific`. `FinderRunResult`
gains OPTIONAL `confirmedCount?`, `pocAttempted?`, `pocExecuted?`, `pocSkippedInfra?`.
The Stage-B focused-confirm model verdict (`"CONFIRMED"|"REVISED"|"REFUTED"`) is
model-internal and **MUST NEVER** map to `ScoredFinding.verdict`; only `promoteWithPoc()`
after real execution sets terminal `CONFIRMED` (regression test).

### 3.2 `poc-prompt.ts` — generation prompt (PURE)

`buildPocGenerationPrompt({finding, pocTarget, files, programRules, systemContext?})`.
Nonce-fenced UNTRUSTED files + finding fields + cited source window. Instructs a
**single straight-line** `testAuditPoc`:

- One `contract`, exactly one public no-arg `function testAuditPoc() public` (no
  modifiers), **no other function/modifier declarations**, and a **straight-line body**:
  NO `if`/`for`/`while`/`do`/`try`/`assembly`/**ternary `?:`** anywhere; no early
  `return`/`revert`.
- Body: deploy `pocTarget.symbol` imported from `pocTarget.path` (exactly one
  `new pocTarget.symbol` instance); set up `preconditions`/`triggerRole` using only the
  allowlisted cheats — `vm.prank`/`vm.startPrank`/`vm.stopPrank`, `vm.deal(address,uint256)`
  (ETH funding of an EOA only), and the fabrication-free environment cheats `vm.warp`/
  `vm.roll` (they set block time/number, altering no contract storage — this restores the
  epoch/time-dependent class, e.g. the der-sc H1 "inverted epoch cap"); **make a non-view
  state-mutating call on that target instance (the DRIVE)**; read that same instance after
  the drive; assert its expected-correct invariant is violated, the assertion operand
  derived from that post-drive read.
- **HARD RULES** (model returns the COMPLETE test file — see the `testContents` contract below):
  - Forbidden: all fabrication/fs/env/process/fork/rpc cheatcodes (§3.3 gate 2 pinned
    list); the HEVM cheatcode address by any means; **any low-level
    `.call/.delegatecall/.staticcall`**; **any inline assembly**; **any contract
    creation except `new <target-or-closure-contract>(...)`** (no `create/create2`,
    `type(X).creationCode`, `new X{salt:…}`); forge-std **state-fabrication wrappers**
    (`StdStorage`/`stdstore`/`checked_write`, `StdCheats` `deal(token,…)`/`hoax`/
    `deployCode`).
  - Declare **no contract/library/interface** other than the test contract; every `new`
    binds to `pocTarget.symbol` or a contract imported from a **cited closure path**
    (no mocks — test-authored or otherwise; no arbitrary literal address as a dependency).
  - `assert*` must be forge-std `Test`/`StdAssertions` (or built-in `assert`); no
    `assertTrue(true)`/constant-only/deployment-only assertions.
  - `testContents ≤ POC_FILE_MAX_BYTES` (24 KB); path is harness-assigned.
- **Output boundary (resolves the body-vs-file ambiguity):** the model returns the
  **complete Solidity test file** as `testContents` (SPDX + pragma + imports + the one
  test contract); the harness assigns only the on-disk path. The AST gates (§3.3) and the
  executor both operate on this full `testContents`; there is no separate wrapper/harness
  layer that could relocate the trust boundary.
- **Decline** → `{testContents:null, rationale}` (needs fork / attacker contract /
  substituted dependency / token-balance / signature / revert-demonstration / unshown code
  / no concrete deployable target).
- Output JSON: `{ testContents: "<full solidity file>" | null, rationale: string | null }`.

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
{passed, reasons, binding?}`** — returns a `PocBinding {targetSymbol, targetPath,
deployedVar, constructorSpan, driveSpan, assertSpan}` on pass, consumed by the executor:
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

**`promoteWithPoc({base, poc}) → {verdict, reason}`:** `base.verdict !== "PURSUE"` →
return `base`. `CONFIRMED` iff `staticGate.passed ∧ executed ∧ compiled ∧ passed ∧
execution.deployedTargetPath === pocTarget.path ∧ execution.drove`. Else **PURSUE** with
the specific reason (declined / static-gate / not-executed / deps-unavailable /
did-not-compile / assertion-did-not-hold / target-path-mismatch / no-drive /
executor-error / generation-failed / requires-live-fork / requires-multi-contract /
requires-substituted-dependency). **Never DROP.**

### 3.4 `poc-executor.ts` — `PocExecutor` interface + `dockerPocExecutor`

`execute({targetRoot, testContents, binding, pocTarget, timeoutMs}) → PocExecResult`
(`{executed,compiled,passed,drove,deployedTargetPath,ranTests,passedTests,failedTests,
skippedTests,exitCode,summary,reason}`). `dockerPocExecutor` (env-gated `SIDECAR_POC_EXEC=1`
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
  trace find the `CREATE` whose resulting contract is `pocTarget.symbol` and capture its
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
- **`drove`** = the `-vvvv` call trace shows a **non-STATICCALL** to that same deployed
  target **address** (from the step above) **after** its CREATE. `assertionExecuted` is
  **not** a trace check — the straight-line gate (no branch/early-return, gate 1) plus a
  forge PASS already guarantees the unconditional assertion executed.
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
  parse+`staticGatePoc` → (if gate passed ∧ `executePoc` present) execute with the
  `binding` → `promoteWithPoc`. Absent callbacks leave the loop + output unchanged.
- `sweep.ts` `auditEntry` gains `poc: boolean`; when `live && poc` composes `generatePoc`
  (`pocModelCall`) + `executePoc` (`dockerPocExecutor`). **Consumer surface:** renderers
  add PoC sections only when ≥1 finding carries a `poc`; the count renders as the atomic
  §1 label; **severity and confirmation are orthogonal — CONFIRMED is NEVER reordered
  above a higher-severity PURSUE**; a top banner states "CONFIRMED reflects local-deploy
  verifiability only; absence does not lower severity — these classes cannot earn it:
  fork, multi-contract/attacker-contract, substituted-dependency, token-balance-dependent
  (ETH-only funding), signature-dependent, and revert-demonstration" and a coverage line
  "executor ran on X/Y eligible
  findings (Z skipped: deps-unavailable / executor-off / class-ineligible)". PURSUE reasons
  distinguish class-ineligible vs **assertion-did-not-hold** (which is neither exoneration
  nor confirmation — a one-line note says so) vs infra. Update **both**
  `buildPursueMarkdown` **and** `buildDedupedPursueMarkdown` (both filter `verdict==="PURSUE"`
  today and would drop CONFIRMED). `SweepEntryOutcome`/`SweepSummary.totals` gain
  `confirmed`, `pocAttempted`, `pocExecuted`, `pocSkippedInfra`.
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
   assert PoC passes and yields a `PocBinding`.
   `resolvePocTarget`: interface/library-only → decline; multi-entry ambiguity → decline.
   `promoteWithPoc` truth table: CONFIRMED only when `staticGate ∧ executed ∧ compiled ∧
   passed ∧ deployedTargetPath===pocTarget.path ∧ drove`; every other combo →
   PURSUE-with-reason; a `CONFIRMED` record always has `humanGated ∧ runSpecific`.
3. `poc-prompt.test.ts`: prompt names `pocTarget`, forbids the full denylist + flags +
   test-authored contracts + assembly + non-`new` creation + forge-std fabrication
   wrappers, defines the decline shape.
4. `run.test.ts`: injected fakes — PURSUE + passing fake exec (path-match + drove) →
   CONFIRMED; gate-failed / target-path-mismatch / no-drive / assertion-failed / declined
   → PURSUE; thrown `executePoc` → PURSUE; DROP untouched; Stage-B `"CONFIRMED"` never
   terminal; no bare `verdict==="CONFIRMED"` without `humanGated` in any rendered/serialized
   path.
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
   scratch removed; host unchanged. Plus a `validateSpikeGoArtifact` unit test with a
   negative fixture per GO predicate (incl. a schema-valid `verdict:"GO"` whose recomputed
   predicates fail → rejected; an artifact faking yield by marking **ineligible** rows
   `humanConfirmedGenuine`/`attempted` → rejected by the eligible-subset recompute; a
   row-consistency violation such as `humanConfirmedGenuine ∧ ¬executed` → rejected; and a
   **duplicate-id** artifact repeating one confirmed eligible id across `pursueSampleIds`/
   `findings` to inflate the denominator → rejected by the uniqueness/bijection check).
9. A real-target **offline whole-project build** completes within the timeout on the
   Phase-2 targets.

## §6 Risks & honest limits

- **`CONFIRMED` is triage, not proof** (§1). Enforced = "real target deployed (build-info
  verified) + non-static drive + post-drive assertion executed"; NOT that the assertion
  captures *this* bug. Human-gated, run-specific; the machine token always co-carries
  `humanGated`.
- **Residual fabrication surface (accepted, human-gated):** an obfuscated cheatcode-address
  the scanner misses; an arbitrary literal address supplied where a real dependency is
  expected; a true-yet-irrelevant post-drive assertion. Forbidding **all** contract creation
  except the target + real closure contracts (no mocks at all) closes the bespoke- AND
  sanctioned-scaffold fake-dependency vectors, at the cost of §2's coverage.
- **Coverage is narrow by design** — single-target local-deploy only; the ineligible
  classes (fork, multi-contract, **harness-dependent**, substituted-dependency,
  token-balance-dependent, signature-dependent, revert-demonstration — §2) stay PURSUE.
  **der-sc itself is ineligible** — it is a v4 hook whose PoC needs a `Deployers`/
  `PoolManager` harness + mock currencies (measured: its human PoC is gate-rejected; see
  §Problem). The eligible class is **not** empty, but it is narrower than der-sc suggested:
  **single-contract, mock-free, EOA-drivable** bugs — access-control, re-initialization,
  and ETH-denominated/parameter accounting (reachable with `vm.prank`/`vm.deal`(EOA)/
  `vm.warp`/`vm.roll`), where a plain deploy-and-call PoC suffices. Actual prevalence in an
  unfiltered PURSUE population is unknown until the Phase-2 spike measures it (§7 GO
  criterion e), and the spike targets must come from this eligible class (not v4-hook/AMM
  targets like der-sc); the banner states absence of CONFIRMED does not lower severity.
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

The der-sc ROI PoC was **human-authored**, and the only GO'd generation spike covered
**fork+oracle**, not local-deploy. A **local-deploy generation spike GATES the executor**:

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
  - `findings: [{ id, targetId, eligible: boolean, ineligibleClass: <§2-class|null>,
    attempted, gatePassed, executed, humanConfirmedGenuine, acceptedHollow }]` — `eligible`
    is graded by the **same blind human**, **independent of the model's own decline** (a
    model under-declining cannot inflate it).
  `validateSpikeGoArtifact(artifact)` **derives every predicate over the ELIGIBLE subset
  `E = findings.filter(f => f.eligible)`, never a whole-array count, and ignores the
  artifact's own `verdict`** (ineligible rows can never offset missing eligible work or
  inflate a numerator). It first enforces **row-consistency invariants** — reject the
  artifact if any finding violates: `humanConfirmedGenuine ⇒ eligible ∧ attempted ∧
  gatePassed ∧ executed ∧ ¬acceptedHollow`; `acceptedHollow ⇒ eligible ∧ attempted ∧
  gatePassed ∧ executed ∧ ¬humanConfirmedGenuine`; `gatePassed ⇒ attempted`;
  `executed ⇒ gatePassed`. Then: `pursueSampled = pursueSampleIds.length`;
  `eligible = |E|`; `confirmedEligible = count(f ∈ E where f.humanConfirmedGenuine)`;
  `acceptedHollow = count(f where f.acceptedHollow)`; `prevalence = eligible / pursueSampled`.
  GO iff ALL: (a) `pursueSampled ≥ 20` (a non-trivial denominator) and `eligible ≥ 6`
  across `≥ 2` distinct targets with `≥ 1` `hasReferencePoc:false` (der-sc may be included,
  not the sole basis); (b) **`E.every(f => f.attempted)`** (every eligible finding is
  attempted — `eligible ⊆ attempted`, a subset property, not count-equality, so incidental
  non-declined ineligible attempts do not fail it) AND `confirmedEligible / eligible ≥ 0.30`
  (yield measured strictly over the eligible class); (c) **`acceptedHollow === 0`** —
  acceptedHollow = PoCs that passed ALL gates + executed + promoted-eligible yet a blind
  human judges hollow (the **false-accept** rate, NOT the gate-rejection rate); any `> 0` →
  NO-GO (fix gates, re-spike); (d) `offlineBuildOk` on a
  real target; (e) **`prevalence ≥ 0.10`** — the eligible class must be common enough in an
  unfiltered sample to justify the executor. **NO-GO → ship Phase 1, keep #179 open, do not
  build the executor.**
- **Phase 3 (post-GO only):** `dockerPocExecutor` (§3.4) + execution wiring + terminal
  `CONFIRMED`; `SIDECAR_POC_EXEC` refuses to run unless `validateSpikeGoArtifact()` passes
  on the committed `SPIKE_RESULT.json` (schema-valid AND every predicate **recomputed** GO
  from the per-finding array — not merely `verdict==="GO"`). Then a **cross-model audit of
  the full executor diff** before enabling in any real run. Executor stays opt-in throughout.

### Deferred future increment (NOT v1) — a bounded-harness lane

The strict single-target scope excludes **harness-dependent** bug classes (Uniswap-v4
hooks, AMMs, lending) whose PoC needs a test fixture — a `Deployers`/`PoolManager`-style
base + mock currencies (the der-sc class; scope caveat in §Problem). Re-including them is a
**deliberate future increment, not a quick allowlist flip**, because it re-opens the exact
fabrication surface the §3.3 gates close: once any base/mock is permitted, a *settable*
mock the target trusts (a `MockOracle.setPrice`) can inject the state the assertion then
"exploits" → a hollow CONFIRMED. It requires its own spec + spike + cross-model audit, and
at minimum: (a) a **content-hash allowlist** of specific vetted harness bases + mock
sources (never an arbitrary base/mock); (b) a static rule permitting a mock only as
**benign scaffolding** (a currency the pool trades), never as the dependency whose
behavior IS the finding; (c) a **runtime check** (Phase-3 trace) that the asserted state
was not produced by a mock the test configured. **Decision (2026-08-29): keep v1 strict;
this lane is gated on the strict lane first proving value via the §7 GO spike.** Rationale:
soundness before coverage — CONFIRMED's whole worth is that it is not hollow.
