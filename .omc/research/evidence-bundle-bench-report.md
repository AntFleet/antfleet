# Evidence Bundle Bench Report

Generated: 2026-06-23T14:56:13.426Z

Source: persisted `finding_validation_evidence_bundles` for `AntFleet/bench-*` benchmark findings from the last 90 days. Derivable gate-output coverage is reported separately from persisted bundle coverage.

Flags set in-process for this read-only report:
- `ANTFLEET_REACHABILITY_GATE=true`
- `ANTFLEET_PATCH_VERIFY=true`
- `ANTFLEET_EVIDENCE_BUNDLE=true`

No reachability or patch-verification work was recomputed.

| Repo | findings | persisted complete | persisted partial | persisted empty | persisted unavailable | derivable complete |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AntFleet/bench-agentfloat | 5 | 0 | 0 | 0 | 5 | 0 |
| AntFleet/bench-hermes-desktop | 5 | 0 | 0 | 0 | 5 | 0 |
| **total** | **10** | **0** | **0** | **0** | **10** | **0** |

Complete public receipt candidate: _none found in persisted public-eligible bundle rows_

Notes:
- Persisted complete means all three renderable slots are present in `finding_validation_evidence_bundles`: public PoC text, reproduction command, and reachability `entryPoint + callPath`.
- Derivable complete means stored `review_gate_outcomes` contain enough data to build all three slots, but does not prove the evidence bundle writer/table path succeeded.
- Partial means one or two slots are present.
- Empty means the persisted bundle row has no renderable evidence slots.
- Unavailable means migration 0042 is not applied in the queried database, so persisted bundle coverage could not be read.
- This report reads stored database outputs only because this session was constrained not to recompute #2 or #5.
