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

## Monitoring

Re-check status periodically. If merged: capture merge SHA, update this
file, then the merge SHA becomes the first cross-repo receipt anchor on
antfleet.dev/receipts (manual or sweep-triggered linkage — TBD by
operator).

## Notes

- AntFleet has no install on Liquid-Protocol-Ops/agent-autonomopoly. Both PRs are one-off contributions from the benchmark run, not a permanent integration.
- Identity used: a dedicated bot user `antfleet-ops` was created and added to the AntFleet GitHub org with Owner role specifically for opening these PRs. Auth swap was done before any publishing action; `Augustas11` was not the PR author.
- The two underlying benchmark PRs on our fork (`antfleet/agent-autonomopoly-bench` PR #2, #4) remain open as demo artifacts and provide the audit trail for each finding.
