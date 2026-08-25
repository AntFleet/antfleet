# SPEC: Rust support for the repro-exec verify pipeline

Status: proposed · 2026-08-25
Motivating run: ratspeak bench (`bench-ratspeak`) — unanimous MEDIUM finding on
`Duration::MAX` passed to `await_ready`. The patch stage ended `models_disagreed`
(no candidate), and even with a patch, the exec image could not have verified it:
Rust benches are `inconclusive` by design today.

## Problem

The repro-exec verify workflow (`.github/workflows/repro-exec-verify.yml`,
Build 2b #159–#164) executes model-generated repro tests to prove a bug
reproduces on base and disappears under the patch. Its toolchain coverage is:

| Ecosystem | Runner detection | Exec-image support | Status |
|---|---|---|---|
| JS/TS (npm/pnpm) | ✅ root lockfile | ✅ (+ `dep_prefetch` since #164) | live |
| Python (pytest) | ✅ pyproject/pytest | ✅ stdlib-only suites | live |
| Go | ✅ go.mod | ❌ | honest `inconclusive` |
| Bun/Yarn/Foundry | ❌ detector gap | ❌ | not detected |
| **Rust (cargo)** | ❌ detector gap | ❌ | not detected |

Rust is the largest uncovered surface among Liquid-tier agent repos (mesh,
wallet, and infra clients skew Rust/C++). Today every Rust finding ends its
lifecycle at "agreed, unverified" unless an operator reads dependency source by
hand — which is exactly the ad-hoc path this spec exists to retire.

## Proposed change

### Phase 1 — detection (small)

Extend `detectRunner` (apps/web, repro-verify detector) to recognize a workspace
root via `Cargo.toml` (workspace `[workspace] members` or `[package]`). Map to a
new runner kind `cargo`. Detection alone keeps verdicts at honest
`inconclusive: runner_unavailable` until Phase 2 ships.

### Phase 2 — exec image toolchain

Add a Rust stable toolchain (rustup + cargo, pinned version) to the exec image
used by the `exec` phase. Constraints carried over from the existing invariants:

* The container stays `--network none` for every verdict-relevant command.
* Cargo needs a registry to build anything non-trivial → mirror the dep-prefetch
  pattern (#164): one opt-in `dep_prefetch` step runs `cargo fetch` in a
  short-lived networked container before the offline suite; the vendor dir /
  cargo home tarball rides into the offline exec container.
* Suites that need network at test-time still degrade to safe `inconclusive`.

### Phase 3 — patch-aware verification semantics

Repro specs for Rust findings follow the same contract as JS/TS: reproduce on
the reviewed SHA, stop reproducing under the suggested patch. For
`models_disagreed` findings (no shipped patch) there is nothing to verify — the
finding stays "as-agreed" and the page says so (structured
`verification_status='inconclusive'`, method `repro_exec`, per migration 0056).

## Non-goals

* C++ / embedded toolchains (rsDeck/rsCardputer class repos) — later.
* Running upstream CI (never; workflows are stripped from all benches).

## Acceptance

1. A bench fork of a cargo workspace detects runner `cargo`.
2. With `dep_prefetch=true`, a stdlib-only + vendored-deps crate reaches
   `verified` end-to-end on a seeded finding.
3. Verdicts persist to `review_gate_outcomes` with witnessability provenance.
