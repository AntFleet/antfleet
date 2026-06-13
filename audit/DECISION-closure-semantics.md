# Decision: Closure-Receipt Semantics (T3.3)

**Status:** Pending operator decision
**Audit ref:** AUDIT-2026-06-13.md §5 M4, Open Question 1
**Code under review:** `apps/web/lib/sweeper.ts`

---

## 1. Current Behavior

`classifyFindings` (sweeper.ts:31-53) marks a finding "closed" whenever its evidence
file path appears in the set of files that changed between `reviewCommitSha` and the
current default-branch HEAD:

```
// sweeper.ts:42-51
const changed = new Set(args.changedFiles);
return args.findings.map((f) => {
  if (changed.has(f.evidencePath)) {
    return {
      findingId: f.findingId,
      status: "closed" as const,
      closureSha: args.currentMainSha,   // ← HEAD SHA pinned as "closing commit"
    };
  }
  return { findingId: f.findingId, status: "still_open" as const };
});
```

The changed-file list comes from `repos.compareCommits` (sweeper.ts:119-125), which
returns every file touched by any commit between the review SHA and HEAD — renames,
doc edits, unrelated refactors, and actual bug fixes alike. The `FindingForClosureCheck`
type (sweeper.ts:12-15) carries only `findingId` and `evidencePath`; no line range is
passed into this function.

The `closureSha` is pinned to `currentMainSha` (HEAD at sweep time), not the specific
commit that touched the file. The public receipt (`formatClosureReceipt` in
pr-comment.ts:257-281) renders this SHA as the authoritative "closed in [sha]" link.

---

## 2. The Over-Claim Problem

AntFleet's core trust artifact is the SHA-pinned public closure receipt — it asserts
"this specific finding was addressed in this specific commit." The current heuristic
conflates "a developer touched this file for any reason" with "the developer fixed
the reported bug," and it pins HEAD-at-sweep-time rather than the commit that actually
changed the file.

A doc-comment edit, an unrelated rename, or an import reorder in the same file will
mark a CRITICAL security finding "closed" and post a receipt on the original PR. The
receipt names a commit that may have no relationship to the finding, creating a
publicly-verifiable false claim on the product's most-trusted artifact. This is
directly contrary to the product's stated positioning: "public SHA-pinned receipts
are the thing customers cannot fake" (pr-comment.ts:241-242).

The current comment (sweeper.ts:4-10) acknowledges the heuristic is intentionally
cheap and assumes "agreed findings are ~100% real, so 'file got touched' is a strong
proxy for 'the bug got addressed.'" This is a reasonable bet for most findings, but
the false-positive scenario is not recoverable without the retraction flow
(schema.ts:211-213), which currently has no automated trigger.

---

## 3. Implementation Options

### Option A — File-Changed (current, status quo)

**What it does:** Mark closed if `evidencePath` appears in `compareCommits` file list.

**Implementation sketch:** No changes. This is the existing path at sweeper.ts:42-51.

**False-positive profile:** Any edit to the evidence file — doc, style, rename,
unrelated logic change — triggers closure. High false-positive rate for active files
(e.g., large utility modules where findings are common and unrelated commits are
frequent).

**False-negative profile:** Zero. If the bug fix touched the file, it is always
caught.

**Data-migration impact:** None. `finding_status` has no line-range columns; the
`FindingForClosureCheck` type already matches what the DB supplies.

---

### Option B — Lines-Changed

**What it does:** Mark closed only if the diff between `reviewCommitSha` and HEAD
contains at least one hunk that overlaps the finding's original evidence line range
(`startLine`..`endLine`).

**Implementation sketch:**

1. Add `startLine: number | null` and `endLine: number | null` to
   `FindingForClosureCheck` (sweeper.ts:12-15).
2. Populate those fields in the sweeper's DB query (currently in
   `apps/web/lib/sweep.ts` where open findings are fetched) by joining to
   `reviews.agreement_decision` JSONB and extracting `evidence[0].startLine/endLine`,
   or by adding `evidence_start_line` / `evidence_end_line` columns to
   `finding_status` (new migration).
3. In `classifyFindings`, if line range is present, inspect the `patch` strings
   already present on the `compareCommits` response (GitHub returns hunk data
   by default) for hunk headers (`@@ -oldStart,oldCount +newStart,newCount @@`)
   and test range overlap. Fall back to file-changed if range is null or if the
   file entry has no `patch` (GitHub omits `patch` for binary files and
   very large diffs).

**False-positive profile:** Reduced. An unrelated edit to line 500 of a file where
the finding is at lines 20-35 would not trigger closure. Still fires on refactors
that move the flagged lines within the same file without fixing the bug (line numbers
shift; the hunk overlaps the original range; but the logic is unchanged).

**False-negative profile:** Low-but-nonzero. A fix that extracts the vulnerable
function to a new file leaves the original path untouched; the finding stays open
indefinitely unless the sweeper also tracks renamed paths.

**Data-migration impact:** Moderate. Two paths exist:

- *Schema-light path:* Extract `startLine`/`endLine` at sweep time from
  `reviews.agreement_decision` JSONB (already stored). No new columns. Avoids
  migration but adds a JSONB extraction overhead per sweep iteration.
- *Schema-full path:* Add `evidence_start_line` / `evidence_end_line` integer columns
  to `finding_status`. Requires a new migration (next sequential after 0039) applied
  against the shared dev/prod Neon DB (see project memory: dev and prod share ONE Neon
  endpoint — ep-crimson-hall/neondb). Backfill is feasible: re-read
  `agreement_decision` for all existing rows and populate from `evidence[0]`. No
  column is `NOT NULL`, so the migration is non-blocking and backward-compatible.

---

### Option C — Hunk-Overlap

**What it does:** Fetch the full unified diff for each finding's file between
`reviewCommitSha` and HEAD via `repos.compareCommits` (already called), parse every
hunk header, and close only if a hunk's changed-line range overlaps
`[startLine, endLine]`.

**Implementation sketch:**

1. Same line-range storage changes as Option B (schema-light or schema-full).
2. In `detectClosuresWith` (sweeper.ts:83-141), after `compareCommits` returns,
   filter `compare.data.files` to the finding's `evidencePath`, then parse the
   `patch` string (GitHub's unified-diff fragment, e.g.
   `@@ -15,6 +15,8 @@ ...`) using a small hunk-header regex. Compute overlap of
   each hunk's `[oldStart, oldStart + oldCount)` against the finding's
   `[startLine, endLine]`.
3. The `compareCommits` call already fetches `patch` data when the diff is within
   GitHub's size limit (300 files, 20 000 additions). For repos exceeding this,
   fall back to file-changed.
4. The pure `classifyFindings` function receives pre-parsed overlap booleans; its
   signature changes from `changedFiles: readonly string[]` to a richer type.

**False-positive profile:** Tightest. Only fires when the actual changed lines
overlap the flagged range. Still susceptible to a fix that rewrites the function
in place without moving the line numbers but without actually fixing the bug
(semantic fix that looks syntactic).

**False-negative profile:** Highest. Fixes that move the code to a new file, split
the function, or rewrite the module entirely will leave the finding open even when
the bug is fixed. Hunk parsing also fails for binary files, very large diffs, and
cross-file refactors.

**Data-migration impact:** Same as Option B (line-range storage). Additional
operational cost: `patch` strings are included in `compareCommits` response only
when the diff is within GitHub's undocumented size limit. Exceeding the limit returns
`patch: undefined`; a fallback to file-changed is required, meaning the tightest
option degrades to the cheapest in practice for large repos.

---

## 4. Recommendation

**Option B (Lines-Changed, schema-light path)** is recommended.

Option A's false-positive rate is unacceptable for the closure receipt, which is
described internally as "the thing customers cannot fake" — a receipt pinning an
unrelated commit undermines the product's core trust claim and requires manual
retraction to correct.

Option C adds significant parsing complexity, a diff-size fallback path (meaning it
silently degrades to Option A for large repos), and the highest false-negative rate
for legitimate refactors. The marginal precision gain over Option B does not justify
the operational surface.

Option B's schema-light path (extract `startLine`/`endLine` from the existing
`reviews.agreement_decision` JSONB at sweep time) adds no migration risk against the
shared dev/prod Neon DB and no backfill requirement — the extraction is per-sweep,
not per-row-at-write. The only cost is a slightly more complex sweep query. If the
operator prefers durable storage over per-sweep extraction, the schema-full path
adds one non-blocking migration (nullable columns, safe backfill).

The false-negative risk of Option B (fixes that move code to a new file) is
acceptable: the sweeper is not the only signal — the reviewer re-runs on the next PR
touching the repo, and line ranges change slowly in practice.

---

## 5. Operator Decision

Select one option to gate implementation of T3.3:

- [ ] **Option A — File-Changed (status quo):** Accept current behavior; document the
  false-positive risk in the product. No code changes required.
- [ ] **Option B — Lines-Changed:** Narrow closure to findings whose original evidence
  line range was touched. Recommended.
- [ ] **Option C — Hunk-Overlap:** Tightest signal; parse hunk headers from unified
  diff. Accept complexity and fallback-to-file-changed for large repos.

Once an option is selected, implementation proceeds in `apps/web/lib/sweeper.ts`
(and optionally a new migration for the schema-full path under Option B).
