# Phase 0 corpus — ground truth

5 real-repo bugs from a downstream codebase, each with an attached gate
verification (`.passing` recipe). This file documents what the LLM stack is
expected to surface; **do not pass it to the LLMs at review time** (the spike
runner walks only source files, not `.md`).

## Reproducing locally

Downstream source files are NOT committed to this repo (they belong to a
separate project; we treat them as ephemeral inputs to the spike). To
reproduce the Phase 0 spike, populate `examples/antseed-corpus/apps/` on
your local disk with copies of these five files from a downstream working
tree:

```
apps/desktop/package.json
apps/desktop/src/renderer/modules/chat.ts
apps/diem-staking/src/lib/actions.ts
apps/diem-staking/src/lib/hooks.ts
apps/website/src/lib/useLatestDesktopDownload.ts
```

The path tree under `examples/antseed-corpus/apps/` is gitignored. Once the
files are in place, run:

```
pnpm spike --providers anthropic,openai --mode unanimous --runs 3 \
  --corpus examples/antseed-corpus
```

Reports land in `examples/antseed-corpus-results/run-N-*.md`; the verdict
lives at `WEEK1-VERDICT-V2.md` in the same directory.

## Selection criteria

- Gate-verified: a `.passing` marker exists for the bug id in the upstream
  findings ledger (recipe ran and surfaced the bug locally).
- Not currently open as a PR (so we have not already shipped a fix that the
  LLMs could be reading via training data).
- File path lives under `apps/desktop`, `apps/ant-station`, `apps/website`, or
  `apps/diem-staking` (the application-layer slices, not the protocol/contract
  layer).
- Across at least 3 different slices.
- Category diversity preferred.

5 bugs qualified after applying the criteria; this corpus uses all 5. The
exclusion list dropped BUG-157 (currently open as a PR upstream).

## Slice and category coverage

| Slice         | Bugs                   | Categories represented                                  |
| ------------- | ---------------------- | ------------------------------------------------------- |
| desktop       | BUG-018, BUG-159       | dep, numerical                                          |
| diem-staking  | BUG-155, BUG-156       | security/UX, observability/UX                           |
| website       | BUG-158                | perf/availability                                       |

3 slices × 5 distinct categories.

## Ground-truth bugs

### BUG-018 — Electron 31.x below CVE-2025-55305 fix line

- **File:** `apps/desktop/package.json` (line containing `"electron": "^31.6.0"`)
- **Severity:** Medium
- **Category:** dep / security
- **Repro:** Verify the `electron` pin in `apps/desktop/package.json` is `^31.x` while Electron 35.7.5+ has fixes for CVE-2025-55305 (ASAR integrity bypass) and CVE-2026-34781 (clipboard DoS).
- **Exact evidence quote (from upstream BUGS.md):**
  ```
  "electron": "^31.6.0",
  ```
- **Notes for matching:** Vulnerability is a stale pin in a JSON manifest, not a runtime code defect. LLMs that ignore non-source files (`*.json`) or that lack CVE awareness will miss this. The spike harness walks `.ts`/`.tsx`/`.js`/`.jsx`/`.json` (see scripts/spike.ts after Phase 0); a model still has to recognize that an `^31.x` Electron pin is outdated.

### BUG-155 — `useApproveDiem` requests `maxUint256` allowance

- **File:** `apps/diem-staking/src/lib/actions.ts:12-23`
- **Severity:** Medium
- **Category:** security / UX
- **Repro:** Inspect `useApproveDiem.run()`; observe `args: [DIEM_STAKING_PROXY, maxUint256]`. Every approval prompts users to authorize an unbounded DIEM allowance to the proxy.
- **Exact evidence quote (from upstream BUGS.md):** `useApproveDiem.run()` calls `writeContractAsync({ args: [DIEM_STAKING_PROXY, maxUint256] })`.
- **Notes for matching:** The bug is "unlimited ERC-20 allowance" — a well-known security anti-pattern. Models should flag the `maxUint256` constant as the smoking gun.

### BUG-156 — `fetchDiemPrice*` swallows errors with bare `catch {}`

- **File:** `apps/diem-staking/src/lib/hooks.ts:19-39` (`fetchDiemPriceFromCoinGecko`), `:41-70` (`fetchDiemPriceFromDexScreener`)
- **Severity:** Low
- **Category:** observability / UX
- **Repro:** Both helpers have `try { … } catch {}` that discard the error. When both providers fail, `useDiemPrice` returns `null` and the UI shows `'—'` indistinguishably from initial loading.
- **Exact evidence quote (from upstream BUGS.md):** "Both price-fetch helpers wrap their `fetch` + `json()` in `try { … } catch {}` blocks that discard the error entirely."
- **Notes for matching:** Two `catch {}` empty-body patterns in the same file. Models should call out the bare catch and the loss of error signal.

### BUG-158 — `useLatestDesktopDownload` unauthenticated GitHub API call on every render

- **File:** `apps/website/src/lib/useLatestDesktopDownload.ts:164-179`
- **Severity:** Low
- **Category:** perf / availability
- **Repro:** On every render of a download-CTA page, the hook fires `fetch('https://api.github.com/repos/AntSeed/antseed/releases/latest')` with no caching. GitHub's unauthenticated REST API limit is 60 req/hr/IP — a single NAT can exhaust the budget.
- **Exact evidence quote (from upstream BUGS.md):** "fires `fetch('https://api.github.com/repos/AntSeed/antseed/releases/latest')` from the visitor's browser. GitHub's unauthenticated REST API limit is 60 req/hr/IP."
- **Notes for matching:** "Unauthenticated GitHub API + no caching + per-render" is the cluster to look for. Models should flag rate-limit exposure and/or absence of caching strategy.

### BUG-159 — `fetchAndApplyMeteringStats` precision loss via `Number()` on 6-decimal USDC bigint strings

- **File:** `apps/desktop/src/renderer/modules/chat.ts:750, 754, 761`
- **Severity:** Low
- **Category:** numerical
- **Repro:** Each line does `Number(stats.reservedUsdc) / 1_000_000` (and `consumedUsdc`, `lifetimeAuthorizedUsdc`). Above ~9 billion USDC the `Number()` cast truncates the bigint string. Comment on `:748` even notes the values are "6-decimal bigint strings".
- **Exact evidence quote (from upstream BUGS.md):** `Number(stats.reservedUsdc) / 1_000_000`
- **Notes for matching:** Three call sites in a 2868-line file. The bug is the *cast itself*, not a UI rendering issue. Models that match category=numerical and evidence in `chat.ts:740-770` window count.

## Matching policy for the spike

A model "caught" a bug when its finding has at least one evidence entry whose
path ends with the bug's source file (`endsWith(bug.file)`) and whose line
range overlaps the bug's line range. This matches the matcher in
`scripts/spike.ts`. The category does not need to match — bugs can be filed
under different category labels by different reviewers.

A model "did not catch" a bug if no finding meets the path-and-range criterion
within the run. A finding that matches the path but with disjoint lines is
**not** counted as a catch — the LLM has to point at the right place.
