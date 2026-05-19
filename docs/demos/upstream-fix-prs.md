# AntFleet — Upstream Fix PRs on agent-autonomopoly

> **Note:** Monitoring is now automated via the `outgoing_prs` table
> (migration `0007_*`). The cron sweep polls each row's upstream merge
> state hourly and surfaces merged ones on `/receipts` under the
> Cross-repo receipts section. This file remains as the human-readable
> mirror — useful for adding context per PR — but the closing SHAs
> below stay informational; the source of truth is the table.

Opened: 2026-05-18T05:27:33Z
Author: `antfleet-ops` (GitHub user; member of AntFleet org)

## PR 1 — Threshold harmonization

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/3
- Branch on fork: `antfleet/agent-autonomopoly-bench:fix/threshold-harmonization`
- Source finding: https://github.com/AntFleet/agent-autonomopoly-bench/pull/2#issuecomment-4474296146
- Status: open
- Closing SHA (if merged): _fill later_

## PR 2 — Husky prepare fix

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/4
- Branch on fork: `antfleet/agent-autonomopoly-bench:fix/husky-prepare-omit-dev`
- Source finding: https://github.com/AntFleet/agent-autonomopoly-bench/pull/4#issuecomment-4474295846
- Status: open
- Closing SHA (if merged): _fill later_

## PR 3 — FeeLocker selector mismatch (on-chain-monitor skill)

- Upstream PR: _pending — branch pushed, `gh pr create` blocked by classifier; awaiting operator approval_
- Branch on fork: `antfleet/agent-autonomopoly-bench:fix/feelocker-correct-selector`
- Local commit on branch: `f075f6d fix(on-chain-monitor): pin canonical view-call pattern for check: watches`
- Source finding: AntFleet investigation (this branch) → published as agent_findings row `feelocker-selector-2026-05-18` under `antfleet.dev/agents/0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e`
- Status: branch ready, awaiting `gh pr create`
- Diff scope: +71 lines in `skills/on-chain-monitor/SKILL.md` (new "4b. View-function reads" section). No source-code constants change; the source ABI was already correct — the bug was in how the LLM-driven skill executed view-function reads without an explicit pattern, causing it to emit `0xe7acab24` (Seaport `fulfillAdvancedOrder` collision) for `availableFees(address,address)` instead of the correct `0x8296535a`.
- Verification: `cast call 0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF "availableFees(address,address)(uint256)" 0x8767Df39eCeeaeB11554642237aC4E08660aB6A3 0xF4d97F2da56e8c3098f3a8D538DB630A2606a024 --rpc-url https://mainnet.base.org` returns `1760804950210169625` wei (≈ 1.7608 DIEM) on Base mainnet — the agent's claimable balance.
- Closing SHA (if merged): _fill later_

## Monitoring

Re-check status periodically. If merged: capture merge SHA, update this
file, then the merge SHA becomes the first cross-repo receipt anchor on
antfleet.dev/receipts (manual or sweep-triggered linkage — TBD by
operator).

## Notes

- AntFleet has no install on Liquid-Protocol-Ops/agent-autonomopoly. Both PRs are one-off contributions from the benchmark run, not a permanent integration.
- Identity used: a dedicated bot user `antfleet-ops` was created and added to the AntFleet GitHub org with Owner role specifically for opening these PRs. Auth swap was done before any publishing action; `Augustas11` was not the PR author.
- The two underlying benchmark PRs on our fork (`antfleet/agent-autonomopoly-bench` PR #2, #4) remain open as demo artifacts and provide the audit trail for each finding.
