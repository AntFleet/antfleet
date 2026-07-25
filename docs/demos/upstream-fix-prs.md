# AntFleet — Upstream Fix PRs on agent-autonomopoly

> **Note:** Monitoring is now automated via the `outgoing_prs` table
> (migration `0007_*`). The cron sweep polls each row's upstream merge
> state hourly and surfaces merged ones on `/receipts` under the
> Cross-repo receipts section. This file remains as the human-readable
> mirror — useful for adding context per PR — but the closing SHAs
> below stay informational; the source of truth is the table.
>
> **2026-05-26 schema gap (temporary):** Two new closure states surfaced
> on this batch — `closed_absorbed` (our PR closed, fix landed via a
> separate upstream commit) and the associated `closureMethod`,
> `closureSha`, `closureDetectedAt`, `closureConfidence` fields are not
> yet on the `outgoing_prs` schema. Until the absorbed-inline detection
> sprint ships, **this file is the canonical record for `closed_absorbed`
> outcomes**. PR 3 and PR 4 below document the first two cases.
>
> Closure-method legend used below:
> - `merged` — our PR merged upstream (clean attribution; e.g. PR 1, PR 2)
> - `absorbed_inline` — our PR closed without merge, but the fix landed via a
>   separate upstream commit (PR 3, PR 4)
> - `declined` — our PR closed without merge, fix never landed
> - `stale_timeout` — our PR sat open >N days with no upstream engagement

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
- Status: `closed_absorbed` 2026-05-26T23:15:26Z (we closed; see closure comment below)
- closureMethod: `absorbed_inline`
- closureSha: `bab1e4b` — upstream commit by `Gordon Slater` 2026-05-26T22:44:23Z, message `fix(on-chain-monitor): pin view-call pattern, add check: schema, fix selector bug`. Bundles PR 3's view-call pattern + selector fix with adjacent on-chain-monitor work (schema add). Authored 7 days after PR 3 opened.
- closureDetectedAt: 2026-05-26T23:07Z (manual detection by operator during daily watch; auto-detection ships in absorbed-inline detection sprint)
- closureConfidence: high — manual diff comparison confirms the canonical view-call pattern PR 3 introduced is structurally equivalent to what landed in `bab1e4b`. The selector bug (`0xe7acab24` → `0x8296535a`) is addressed implicitly by the new pattern.
- Closed by: `antfleet-ops`. Closure comment on PR: `"Closing — fix appears to have landed via bab1e4b. Glad the issue is resolved."`
- Diff scope: +71 lines in `skills/on-chain-monitor/SKILL.md` (new "4b. View-function reads" section). No source-code constants change; the source ABI was already correct — the bug was in how the LLM-driven skill executed view-function reads without an explicit pattern, causing it to emit `0xe7acab24` (Seaport `fulfillAdvancedOrder` collision) for `availableFees(address,address)` instead of the correct `0x8296535a`.
- Verification: `cast call 0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF "availableFees(address,address)(uint256)" 0x8767Df39eCeeaeB11554642237aC4E08660aB6A3 0xF4d97F2da56e8c3098f3a8D538DB630A2606a024 --rpc-url https://mainnet.base.org` returns `1760804950210169625` wei (≈ 1.7608 DIEM) on Base mainnet — the agent's claimable balance.

## PR 4 — Reposition computeNewRange ordering + assert token0 < token1

- Upstream PR: https://github.com/Liquid-Protocol-Ops/agent-autonomopoly/pull/8
- Branch on fork: `antfleet-ops/agent-autonomopoly:fix/reposition-range-comment-and-ordering`
- Opened: 2026-05-20T06:25:56Z by `antfleet-ops`
- Predecessors (closed by author for identity-swap to antfleet-ops): #6, #7 — both authored by `Augustas11` before the AntFleet org identity convention was finalized. PR #8 supersedes; #6 and #7 should be treated as historical artifacts only.
- Source finding: surfaced during AntFleet retrospective review on agent-autonomopoly-bench. TBD: backfill linkage to a numbered agent_findings row.
- Status: `closed_absorbed` 2026-05-26T20:46:20Z (upstream owner closed without merge ~15 seconds after the inline commit landed)
- closureMethod: `absorbed_inline`
- closureSha: `7329b8a` — upstream commit by `Gordon Slater` 2026-05-26T20:46:05Z, message `fix(security): add explicit workflow permissions + assert token0<token1 ordering`. Bundles PR 4's `token0 < token1` ordering assertion with adjacent workflow-permission hardening. Authored 6 days after PR 4 opened.
- closureDetectedAt: 2026-05-26T23:07Z (manual detection by operator during daily watch)
- closureConfidence: high — the `assert token0 < token1` ordering check that PR 4 introduced is named verbatim in the closing commit's message and present in the closing diff. The `computeNewRange` comment correction may or may not have landed; not verified independently.
- Closed by: upstream owner (`Gordon Slater`). No comment from upstream — PR was closed without explanation; we did not author a closure comment.
- Diff scope: PR 4 added a startup-time runtime assertion `assert token0 < token1` for the reposition flow + corrected the `computeNewRange` comment to match canonical Uniswap v3 invariant ordering. The closing commit `7329b8a` includes the same ordering assertion as part of a broader security hardening pass that also adds explicit GitHub Actions workflow permissions.

## Monitoring

Re-check status periodically. Three closure outcomes are tracked:

- `merged` — capture merge SHA; becomes a cross-repo receipt anchor on `antfleet.dev/receipts`.
- `absorbed_inline` — capture closure SHA on upstream base branch (the commit that applied the fix without merging our PR); should also become receipt-eligible once the absorbed-inline detection sprint ships (schema migration + UI surface update).
- `declined` — capture closure timestamp; not receipt-eligible.

For `absorbed_inline` outcomes, the closure SHA is what matters — not whether our PR was technically merged. The receipt claim is "AntFleet's signal preceded the fix," which holds whether attribution is clean (`merged`) or absorbed (`absorbed_inline`).

## Record summary (as of 2026-05-26)

| PR  | Upstream # | Opened     | Status            | Outcome SHA  | Days to fix |
| --- | ---------- | ---------- | ----------------- | ------------ | ----------- |
| 1   | #3         | 2026-05-18 | `merged`          | `3299eed`    | 1           |
| 2   | #4         | 2026-05-18 | `merged`          | `fb5509c`    | 1           |
| 3   | #5         | 2026-05-19 | `closed_absorbed` | `bab1e4b`    | 7           |
| 4   | #8         | 2026-05-20 | `closed_absorbed` | `7329b8a`    | 6           |

**Net record: 4 substantive PRs filed, 4/4 underlying fixes landed on upstream within 8 days. AntFleet's signal preceded the fix in 100% of cases.** Two via clean merge, two via inline absorption.

## Notes

- AntFleet has no install on Liquid-Protocol-Ops/agent-autonomopoly. All PRs are one-off contributions from the benchmark run, not a permanent integration.
- Identity used: a dedicated bot user `antfleet-ops` was created and added to the AntFleet GitHub org with Owner role specifically for opening these PRs. Auth swap was done before any publishing action; `Augustas11` was not the PR author (with the exception of #6 and #7, which were closed and superseded by `antfleet-ops`-authored #8).
- The underlying benchmark PRs on our fork (`antfleet/agent-autonomopoly-bench` PR #2, #4) remain open as demo artifacts and provide the audit trail for each finding.
- `absorbed_inline` is not yet a first-class state in the `outgoing_prs` schema — see the schema-gap note at the top of this file. The cron sweep currently flips PR 3 and PR 4 to `closed` (declined), which under-counts AntFleet's signal value. Absorbed-inline detection sprint will reconcile.
