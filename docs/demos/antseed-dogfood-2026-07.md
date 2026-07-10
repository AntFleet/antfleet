# AntSeed dogfood — Patch Agent + upstream fixes (2026-07-10)

**Operator:** augstar (untangle pass after prior-session mistakes).
**Agent page:** https://www.antfleet.dev/agents/0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263
**Bench:** https://github.com/AntFleet/bench-antseed (scaffold, **not** a fork)
**Source:** https://github.com/AntSeed/antseed

---

## What this dogfood proved

1. **Review stage finds real issues** on a multi-surface monorepo (Solidity +
   Node payments + CLI proxy) — 3 of 4 flagged findings re-verified as real;
   1 debatable.
2. **Patch Agent generation had two product bugs**, both fixed on AntFleet main:
   - **#131** — agreement-as-veto discarded valid single-model patches.
   - **#132** — prompt lacked real source → hallucinated old-sides that failed
     `git apply`.
3. **Verification is still a no-op on scaffold benches** — `bench-antseed` is a
   30 KB file subset, not runnable. Issue **#133** tracks fork-standardize
   onboarding + repro-test generation so the next partner run gets
   `verified` end-to-end.
4. **Hand-authored upstream fix PRs must be test-run before marking ready** —
   the prior session filed #727/#728 as draft without running AntSeed's suite
   and left load-bearing header reads unfixed. This pass verified + hardened
   both and marked them ready.

---

## Finding ledger (re-verified)

| # | Finding | Verdict | Upstream |
|---|---------|---------|----------|
| 1 | `AntseedDeposits.sol` zeroes `platformFee` when `protocolReserve == address(0)` | **REAL**, possibly **intentional** (deploy-window; invariant tests model fee=0) | No fix — maintainer decision |
| 2 | `getChainConfig` silent mainnet fallback vs doc | **REAL** | [#727](https://github.com/AntSeed/antseed/pull/727) ready |
| 3 | Receipt sig omits `unitPrice` literally | **DEBATABLE** (`costCents`+`totalTokens` pin price) | No fix — maintainer judgment |
| 4 | Proxy header lookups not case-insensitive | **REAL** (routing used direct bracket access) | [#728](https://github.com/AntSeed/antseed/pull/728) ready |

Prior session wrongly dismissed #1 after reading `AntseedChannels.sol` instead
of `AntseedDeposits.sol`.

---

## Upstream fix PRs (antfleet-ops)

### AntSeed/antseed#727 — chain-config throw on unknown chainId

- Branch: `antfleet-ops:fix/chain-config-unknown-chainid`
- File: `packages/node/src/payments/chain-config.ts`
- Behavior: unrecognized non-empty `chainId` throws (no silent mainnet default);
  no-arg still returns `base-mainnet`.
- Tests: `packages/node/tests/chain-config.test.ts` (6 cases)
- Verified: `vitest` chain-config + receipt + balance-manager + base-evm-client → 33 pass

### AntSeed/antseed#728 — proxy header case-insensitivity

- Branch: `antfleet-ops:fix/proxy-header-case-insensitive`
- Files: `apps/cli/src/proxy/{request-utils,routing,buyer-proxy}.ts` + `header-case.test.ts`
- Behavior: `getHeader` case-insensitive + exported; routing overrides and
  buyer-proxy pin-peer / max-upload go through it (first cut only fixed debug
  logging).
- Verified: `node --test dist/proxy/*.test.js` → 57 pass

---

## AntFleet product changes from this dogfood

| PR / issue | What | Status |
|------------|------|--------|
| [#131](https://github.com/AntFleet/antfleet/pull/131) | Verifier-first patch gate | **merged** `9e23e6b` |
| [#132](https://github.com/AntFleet/antfleet/pull/132) | Real-source prompt + apply-floor | **merged** `5115d83` |
| [#133](https://github.com/AntFleet/antfleet/issues/133) | Verify-by-default (fork bench + repro tests) | **open** |
| (new) Review-stage stochastic recall | 2-model recall varies run-to-run on same bench | file if not already |

---

## Process mistakes (do not repeat)

1. Ship generation fixes before verifying them against a runnable target when
   the claim is "patches apply."
2. File upstream fix PRs without running the target's test suite.
3. Publish agent findings citing the wrong source file.
4. Scaffold bench repos when the goal includes patch verification — **fork
   the source** instead (see operator runbook
   `.omc/runbooks/manual_agent_onboarding.md` §1 + issue #133).
   Not `docs/ONBOARDING.md` — that file is the legacy public Onboarder
   design-partner page, not the bench/partner onboarding runbook.

---

## Cleanup backlog

- [ ] Seed `outgoing_prs` for AntSeed #727 and #728 (prod) so receipts flip on merge
- [ ] Re-publish corrected `agent_findings` row (prod; operator authorize)
- [ ] After merges: `publish-antseed-finding.ts --update --pr-url … --merged-sha …`
- [ ] Optional: delete unused `antfleet-ops/antseed` fork only after PRs merge
      (deleting the fork closes the PRs)
- [ ] Consider re-onboarding `bench-antseed` as a real fork for #133 Build 1
