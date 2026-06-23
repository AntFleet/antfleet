# Daybreak gates — bench dry-run evidence

Generated: bench dry-run script
Scope: 60 recent bench reviews across 6 bench repos.

## How to read this

The dry-run is an *end-to-end wiring proof*, not a substantive call on the bench corpus. It demonstrates that (a) the flag check fires, (b) both gates execute their pure paths against real bench data, (c) the fail-open behavior engages on upstream errors, and (d) the gate-outcomes side-table write is attempted (and degrades gracefully when migration 0041 has not been applied).

**Auth fail-open notice.** 8/8 reachability calls landed on `uncertain` because the local Anthropic API key returned 401. The verdicts in the table below therefore reflect the fail-open path, not Haiku's substantive answer. To reach the gate's discriminative output, swap the local `ANTHROPIC_API_KEY` for a valid one and re-run.

**Patch-verifier adapter gap.** 3/3 verifier calls returned `regressed` because the bench-stored `suggested_patch` lives as a GitHub suggestion replacement block, not a unified diff. `git apply` cannot consume the suggestion form. Before flipping the prod `ANTFLEET_PATCH_VERIFY` flag, the verifier needs an adapter that lifts the suggestion's NEW-side lines into a unified diff anchored on the evidence line. The shape of the failure (`exit 128: corrupt patch`) is the structural verdict; it is NOT a real regression in the proposed fix.

## Reachability gate

Calls made: 8 / cap 12

| Repo | reachable | unreachable | uncertain |
| --- | ---: | ---: | ---: |
| AntFleet/bench-hermes-desktop | 0 | 0 | 1 |
| AntFleet/bench-agentfloat | 0 | 0 | 2 |
| AntFleet/bankrskills-bench | 0 | 0 | 1 |
| AntFleet/aeon-bench | 0 | 0 | 3 |
| AntFleet/agent-autonomopoly-bench | 0 | 0 | 1 |

_No disagreements between unanimous consensus and reachability gate in this batch._

## Patch verifier

Calls made: 3 / cap 6

| Repo | verified | regressed | inconclusive |
| --- | ---: | ---: | ---: |
| AntFleet/bankrskills-bench | 0 | 3 | 0 |

### Per-call notes

- **AntFleet/bankrskills-bench** finding `d121d4bf-0` — verdict: regressed
  - detector: none
  - notes: git apply failed (exit 128): error: corrupt patch at line 11


- **AntFleet/bankrskills-bench** finding `d121d4bf-1` — verdict: regressed
  - detector: none
  - notes: git apply failed (exit 128): error: corrupt patch at line 11


- **AntFleet/bankrskills-bench** finding `219fd253-1` — verdict: regressed
  - detector: none
  - notes: git apply failed (exit 128): error: corrupt patch at line 13


## What the user reviews before flipping flags

1. Reachability gate ran end-to-end against the bench reviews above; counts surface per repo.
2. Patch verifier ran end-to-end where the bench data included a `suggested_patch`; verdicts surface per call.
3. No live-protocol HIGH findings published; any flagged in the mutes section route private.
4. Prod flags remain OFF — flip via env after this report is reviewed and migration 0041 has been applied to prod.
