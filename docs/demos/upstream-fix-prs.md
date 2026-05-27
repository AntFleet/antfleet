# AntFleet — Upstream Fix PRs on agent-autonomopoly

> **Note:** Monitoring is fully automated via the `outgoing_prs` table.
> The cron sweep polls each row's upstream state hourly and surfaces
> receipt-eligible rows (both `merged` and `closed_absorbed`) on
> `/receipts`. Absorbed-inline detection (migration `0026`) uses an
> LLM judge to classify closed-without-merge PRs whose fix landed via
> a separate upstream commit. This file remains as the human-readable
> mirror; the source of truth is the table.

Opened: 2026-05-18T05:27:33Z
Author: `antfleet-ops` (GitHub user; member of AntFleet org)

## PR 1 — Threshold harmonization

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/3
- Branch on fork: `antfleet/agent-autonomopoly-bench:fix/threshold-harmonization`
- Source finding: https://github.com/AntFleet/agent-autonomopoly-bench/pull/2#issuecomment-4474296146
- Status: merged 2026-05-19T01:05:58Z
- Closing SHA: `3299eed8c52f41ed01e1a249c0e6c7b6f4e3c649`

## PR 2 — Husky prepare fix

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/4
- Branch on fork: `antfleet/agent-autonomopoly-bench:fix/husky-prepare-omit-dev`
- Source finding: https://github.com/AntFleet/agent-autonomopoly-bench/pull/4#issuecomment-4474295846
- Status: merged 2026-05-19T01:06:01Z
- Closing SHA: `fb5509ce5d31cc108492e1e5b6637253ae0912d2`

## PR 3 — FeeLocker selector mismatch (on-chain-monitor skill)

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/5
- Branch on fork: `antfleet/agent-autonomopoly-bench:fix/feelocker-correct-selector`
- Local commit on branch: `f075f6d fix(on-chain-monitor): pin canonical view-call pattern for check: watches`
- Source finding: AntFleet investigation → published as agent_findings row `feelocker-selector-2026-05-18` under `antfleet.dev/agents/0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e`
- Status: closed without merge (PR closed by antfleet-ops; fix absorbed inline by upstream)
- Expected closure: absorbed_inline → `bab1e4b` (pending cron detection)
- Diff scope: +71 lines in `skills/on-chain-monitor/SKILL.md` (new "4b. View-function reads" section). No source-code constants change; the source ABI was already correct — the bug was in how the LLM-driven skill executed view-function reads without an explicit pattern, causing it to emit `0xe7acab24` (Seaport `fulfillAdvancedOrder` collision) for `availableFees(address,address)` instead of the correct `0x8296535a`.
- Verification: `cast call 0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF "availableFees(address,address)(uint256)" 0x8767Df39eCeeaeB11554642237aC4E08660aB6A3 0xF4d97F2da56e8c3098f3a8D538DB630A2606a024 --rpc-url https://mainnet.base.org` returns `1760804950210169625` wei (≈ 1.7608 DIEM) on Base mainnet — the agent's claimable balance.

## PR 4 — token0<token1 ordering assertion

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/8
- Branch on fork: `antfleet/agent-autonomopoly-bench:fix/token0-token1-ordering`
- Source finding: AntFleet benchmark review
- Status: closed without merge (PR closed by upstream owner; fix absorbed inline)
- Expected closure: absorbed_inline → `7329b8a` (pending cron detection)

## Notes

- AntFleet has no install on Liquid-Protocol-Ops/agent-autonomopoly. All PRs are one-off contributions from the benchmark run, not a permanent integration.
- Identity used: a dedicated bot user `antfleet-ops` was created and added to the AntFleet GitHub org with Owner role specifically for opening these PRs. Auth swap was done before any publishing action; `Augustas11` was not the PR author.
- The two underlying benchmark PRs on our fork (`antfleet/agent-autonomopoly-bench` PR #2, #4) remain open as demo artifacts and provide the audit trail for each finding.
