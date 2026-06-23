# Daybreak threat model bench evidence

Generated: 2026-06-23T15:35:35.230Z
Scope: recent public benchmark reviews, one latest review per repo.

## Summary

| Repo | entry points | trust boundaries | sinks | secrets | assets | added vs current | removed vs current |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| AntFleet/bench-hermes-desktop | 5 | 14 | 25 | 14 | 3 | 5 | 0 |
| AntFleet/bench-agentfloat | 1 | 11 | 25 | 25 | 20 | 0 | 0 |
| AntFleet/bankrskills-bench | 25 | 4 | 23 | 12 | 13 | 18 | 0 |
| AntFleet/aeon-bench | 21 | 17 | 25 | 21 | 5 | 21 | 0 |
| AntFleet/agent-autonomopoly-bench | 15 | 17 | 25 | 25 | 25 | 13 | 0 |
| AntFleet/agent-openhuman-bench | 3 | 24 | 25 | 12 | 7 | 3 | 0 |

## Per repo

### AntFleet/bench-hermes-desktop

- review: 769f19b2-0857-49f4-ac2c-77ebd0abc8be
- sha: 1a9e716ec8d76a60042e8fb9fdd2e9f92d43c4d8
- reachability decision comparison: current=uncertain; threat_model=uncertain; changed=no
- generated threat model:
  - entry points: `cli scripts/e2e-attach.js:76`, `cli scripts/generate-winget-manifests.mjs:7`, `cron src/main/cronjobs.ts:19`, `cron src/renderer/src/screens/Schedules/Schedules.tsx:36`, `queue-consumer src/main/hermes.ts:1124`
  - trust boundaries: 14
  - sinks: 25
  - secrets surface: 14 (internal)
  - critical assets: 3 (internal)
- current changed-file entry points: _none_
- added by persisted model: `cli scripts/e2e-attach.js:76`, `cli scripts/generate-winget-manifests.mjs:7`, `cron src/main/cronjobs.ts:19`, `cron src/renderer/src/screens/Schedules/Schedules.tsx:36`, `queue-consumer src/main/hermes.ts:1124`
- removed by persisted model: _none_

### AntFleet/bench-agentfloat

- review: 57e5c9ae-6bc0-4f58-bfe3-764da171282b
- sha: 1f7a75885700c338a2159beef63e36c242720bdb
- reachability decision comparison: current=reachable; threat_model=reachable; changed=no
- generated threat model:
  - entry points: `queue-consumer agent/src/api.ts:328`
  - trust boundaries: 11
  - sinks: 25
  - secrets surface: 25 (internal)
  - critical assets: 20 (internal)
- current changed-file entry points: `queue-consumer agent/src/api.ts:328`
- added by persisted model: _none_
- removed by persisted model: _none_

### AntFleet/bankrskills-bench

- review: b6cf244f-6009-4fe2-b7b5-05555da06336
- sha: 9b509244786b1e9317f2931bd8712ce1f25640fa
- reachability decision comparison: no HIGH/CRITICAL agreed finding in sampled review
- generated threat model:
  - entry points: `queue-consumer veil/scripts/veil-queue-balance.sh:7`, `cli onchainkit/scripts/component-generator.py:331`, `cli onchainkit/scripts/create-onchain-app.py:16`, `cli onchainkit/scripts/validate-setup.py:31`, `cli bankr-signals/scripts/feed.sh:37`, `queue-consumer bankr-signals/scripts/feed.sh:22`, `queue-consumer bankr-signals/scripts/leaderboard.sh:56`, `cli bankr-signals/scripts/my-signals.sh:32`
  - trust boundaries: 4
  - sinks: 23
  - secrets surface: 12 (internal)
  - critical assets: 13 (internal)
- current changed-file entry points: `cli bankr-signals/scripts/feed.sh:37`, `queue-consumer bankr-signals/scripts/feed.sh:22`, `queue-consumer bankr-signals/scripts/leaderboard.sh:56`, `cli bankr-signals/scripts/my-signals.sh:32`, `cli bankr-signals/scripts/publish-signal.sh:125`, `cli bankr-signals/scripts/subscribe.sh:38`, `queue-consumer bankr-signals/scripts/subscribe.sh:2`
- added by persisted model: `queue-consumer veil/scripts/veil-queue-balance.sh:7`, `cli onchainkit/scripts/component-generator.py:331`, `cli onchainkit/scripts/create-onchain-app.py:16`, `cli onchainkit/scripts/validate-setup.py:31`, `cli endaoment/scripts/donate.sh:10`, `cli ens-primary-name/scripts/set-avatar.sh:17`, `cli ens-primary-name/scripts/set-primary.sh:13`, `cli ens-primary-name/scripts/verify-primary.sh:76`
- removed by persisted model: _none_

### AntFleet/aeon-bench

- review: 5a1afff9-34f3-4652-8ed1-551b44d52ccb
- sha: 6d0181ff6baf3912ec2b25f4059c8dcaca7b1672
- reachability decision comparison: no HIGH/CRITICAL agreed finding in sampled review
- generated threat model:
  - entry points: `http dashboard/app/api/auth/route.ts:30`, `http dashboard/app/api/secrets/route.ts:70`, `http dashboard/app/api/analytics/route.ts:52`, `http dashboard/app/api/import/route.ts:27`, `http dashboard/app/api/memory/issues/[id]/route.ts:4`, `http dashboard/app/api/memory/issues/route.ts:4`, `http dashboard/app/api/memory/logs/route.ts:4`, `http dashboard/app/api/memory/route.ts:4`
  - trust boundaries: 17
  - sinks: 25
  - secrets surface: 21 (internal)
  - critical assets: 5 (internal)
- current changed-file entry points: _none_
- added by persisted model: `http dashboard/app/api/auth/route.ts:30`, `http dashboard/app/api/secrets/route.ts:70`, `http dashboard/app/api/analytics/route.ts:52`, `http dashboard/app/api/import/route.ts:27`, `http dashboard/app/api/memory/issues/[id]/route.ts:4`, `http dashboard/app/api/memory/issues/route.ts:4`, `http dashboard/app/api/memory/logs/route.ts:4`, `http dashboard/app/api/memory/route.ts:4`
- removed by persisted model: _none_

### AntFleet/agent-autonomopoly-bench

- review: f1aedd24-05df-4e18-bb6e-99165feb92c7
- sha: 4904a75cd75c3e830b74bf5d7698f907aa443da7
- reachability decision comparison: current=reachable; threat_model=reachable; changed=no
- generated threat model:
  - entry points: `cli scripts/check-portfolio.ts:8`, `cli scripts/claim-and-allocate.ts:10`, `cli scripts/claim.ts:7`, `cli scripts/create-identity.ts:4`, `cli scripts/deploy-compute-presale.ts:11`, `cli scripts/launch-diem-token.ts:5`, `cli scripts/launch-vvv-token.ts:4`, `cli scripts/lint-identity.ts:1`
  - trust boundaries: 17
  - sinks: 25
  - secrets surface: 25 (internal)
  - critical assets: 25 (internal)
- current changed-file entry points: `cli scripts/claim-and-allocate.ts:10`, `cli scripts/reposition.ts:11`
- added by persisted model: `cli scripts/check-portfolio.ts:8`, `cli scripts/claim.ts:7`, `cli scripts/create-identity.ts:4`, `cli scripts/deploy-compute-presale.ts:11`, `cli scripts/launch-diem-token.ts:5`, `cli scripts/launch-vvv-token.ts:4`, `cli scripts/lint-identity.ts:1`, `cli scripts/swap-0x.ts:9`
- removed by persisted model: _none_

### AntFleet/agent-openhuman-bench

- review: eba8958d-5bcf-423a-bc21-d3e6fb63470d
- sha: 59e046b0c96bc3ed34e8a4367534b77830ca91b2
- reachability decision comparison: no HIGH/CRITICAL agreed finding in sampled review
- generated threat model:
  - entry points: `queue-consumer app/src/utils/oauthAppVersionGate.ts:57`, `cron app/src/utils/tauriCommands/cron.ts:2`, `cron scripts/mock-api/routes/cron.mjs:22`
  - trust boundaries: 24
  - sinks: 25
  - secrets surface: 12 (internal)
  - critical assets: 7 (internal)
- current changed-file entry points: _none_
- added by persisted model: `queue-consumer app/src/utils/oauthAppVersionGate.ts:57`, `cron app/src/utils/tauriCommands/cron.ts:2`, `cron scripts/mock-api/routes/cron.mjs:22`
- removed by persisted model: _none_

## How to read this

Each repo replays at most one HIGH/CRITICAL agreed finding twice: current changed-file-only context, then the same finding with persisted threat-model entry points supplied to the gate. The added/removed lists show the input-context delta behind those verdicts.
