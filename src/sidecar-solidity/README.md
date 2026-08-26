# Whole-contract Solidity finder sidecar

Implements [`specs/SOLIDITY_SIDECAR_SPEC.md`](../../specs/SOLIDITY_SIDECAR_SPEC.md)
(§3 of the parent spec). Finding-phase only.

## What it is / is not

- **Is:** a whole-contract finder that assembles the full bidirectional
  dependency closure of an entry contract (forward imports + reverse
  factory/symbol coupling), runs ONE neutral fund-extraction finder call over it,
  and scores findings through the four program-rule factors
  (`scoreAuditFinding`, reused unchanged from `killtest.ts`).
- **Finds:** cross-file / cross-contract bugs the PR-diff reviewer structurally
  misses — factory/instance trust, proxy/impl splits, accounting across
  contracts. Mechanism evidence: Biconomy C4-2023-01 H-03, where the single-file
  arm structurally missed and the closure arm caught it at CRITICAL
  (`solidity-killtest/RESULT.md`; N=1, demonstrated not proven).
- **Is NOT:** an uplift on single-file inline bugs (measured: no uplift). Not a
  verifier: nothing here executes a PoC or confirms exploitability. Not a
  submitter: bounty submission is always a human action. The parked Foundry lane
  stays parked.

## Usage

```sh
# DRY-RUN (default): assemble closure, render prompt, NO model call, no key needed.
pnpm audit-solidity \
  --target <checked-out repo dir> \
  --entry contracts/Wallet.sol \
  --rules program-rules.md

# LIVE: one finder call via model-client (needs ANTHROPIC_API_KEY).
pnpm audit-solidity --target ... --entry ... --rules ... --live --out report.json
```

Closure stats print to stderr; the prompt/report goes to stdout and `--out`.

## Honest limits

- Closure bounding can evict relevant files under budget pressure; evicted files
  are listed in every report so misses are traceable. Entries are never evicted.
- Reverse coupling heuristics (compound names like `XFactory.sol`) can
  over-include; that costs tokens, not correctness, and the budget caps it.
- Output is unverified candidate findings with self-reported rule factors. Read
  them like the redacted-cartel integrity catch taught us: never blindly trusted.
- Value claim is conditional on cross-file bug classes. It does not generalize.
