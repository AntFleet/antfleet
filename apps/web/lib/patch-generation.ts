// Patch Agent v1.5 — per-review patch generation orchestrator.
//
// Sits between the agreement gate (which produces the agreed[] findings the
// review will comment on) and the patch agreement gate (PR3, which decides
// which patches actually ship). For each agreed finding, calls each provider's
// `proposePatch` in parallel with a 60s timeout, then applies the post-call
// validation: must target a path that exists in the PR's changed files, must
// land inside a diff hunk, must be within the 20-line size cap.
//
// Pure-orchestration: this module does no DB I/O and does not post comments.
// It returns a structured payload the caller (review-worker) persists into
// finding_status.suggestedPatch / patchSkipReason in PR4+. Wiring into
// review-worker lands in PR4 to keep PR2 a pure additive primitive.

import type { Finding } from "./review-types";
import type { ChangedFile } from "./github-files";
import {
  countAddedLines,
  parseHunkRanges,
  rangeFallsInsideHunk,
  rangeOverlapsHunk,
  type HunkRange,
} from "./diff-hunks";
import type { PatchSuggestionResult } from "@antfleet/cli/types";
import type { PatchSkipReason, ProviderPatchProposal } from "@antfleet/cli/providers/patch-gate";
import { normalizePatchForApply } from "./patch-adapter";

// Per-call timeout. The whole review must finish under 240s; the existing
// per-provider review call already burns up to ~60s, so the patch call
// budget is matched at 60s to keep parallel wall-clock predictable.
export const PATCH_GENERATION_TIMEOUT_MS = 60_000;

// Spec §2: cap patch output per finding at 20 changed lines. PRs whose
// findings need bigger fixes fall through to patchSkipReason="size_cap".
export const PATCH_SIZE_LINE_CAP = 20;

export type { PatchSkipReason, ProviderPatchProposal };

export type PatchGenerationResult = {
  proposals: ProviderPatchProposal[];
  // Total wall-clock for the fan-out. Tracked so the review-worker can log
  // and so future re-pricing analysis sees the cost.
  elapsedMs: number;
};

// Provider surface this orchestrator needs. Matches the optional
// `proposePatch` method on @antfleet/cli's Provider type. Declared
// structurally so the test suite can inject a mock without pulling the
// whole Provider interface.
export type PatchProposingProvider = {
  name: string;
  proposePatch: (
    root: string,
    prompt: string,
    model: string | null,
  ) => Promise<PatchSuggestionResult>;
};

export type GenerateReviewPatchesArgs = {
  reviewId: string;
  findings: readonly Finding[];
  // findingId aligned with findings[] index — review-worker derives this via
  // makeFindingId(reviewId, index) before persisting. Passed in explicitly so
  // this orchestrator doesn't depend on the DB helper.
  findingIds: readonly string[];
  changedFiles: readonly ChangedFile[];
  providers: readonly PatchProposingProvider[];
  model?: string | null;
  // For tests. Production callers omit and the orchestrator uses Date.now.
  now?: () => number;
  // For tests. Production callers omit and the orchestrator uses setTimeout.
  timeoutMs?: number;
};

/**
 * Fan out per-finding patch generation across providers. Returns one
 * `ProviderPatchProposal` per (finding × provider) pair. The agreement gate
 * (PR3) consumes the full list; this function does not pick a winner.
 *
 * Failure isolation:
 *   - A provider throwing (API error) → that provider's proposal becomes
 *     `{ patch: null, skipReason: "generation_error" }`. Other providers
 *     are unaffected.
 *   - A timeout → same outcome as a thrown provider.
 *   - A patch that targets a path absent from the PR diff, or lines outside
 *     a hunk → `{ patch: null, skipReason: "outside_diff_hunk" }`.
 *   - A patch that exceeds the line cap → `{ patch: null, skipReason: "size_cap" }`.
 *   - A patch whose old-side block can't be located in the real source file
 *     (hallucinated/stale context that would fail `git apply`) →
 *     `{ patch: null, skipReason: "patch_apply_failed" }` (always-on apply-floor).
 *   - A `patch: null` decline from the model → carried through with no
 *     skipReason; the gate interprets the absence as "this provider opted out".
 *     Equivalent to "models_disagreed" once paired with the other side.
 *
 * The orchestrator is idempotent at the level of (reviewId, findingId): the
 * call signature accepts the findingId so re-runs produce results keyed
 * the same way. Actual idempotence on the DB write side is enforced by
 * PR4's persistence layer.
 */
export async function generateReviewPatches(
  args: GenerateReviewPatchesArgs,
): Promise<PatchGenerationResult> {
  const now = args.now ?? Date.now;
  const timeoutMs = args.timeoutMs ?? PATCH_GENERATION_TIMEOUT_MS;
  const t0 = now();

  if (args.findings.length !== args.findingIds.length) {
    throw new Error(
      `generateReviewPatches: findings (${args.findings.length}) and findingIds (${args.findingIds.length}) must align`,
    );
  }
  const hunksByPath = buildHunkIndex(args.changedFiles);
  const changedPaths = new Set(args.changedFiles.map((f) => normalizePath(f.filename)));
  // Apply-floor input: the real source of each changed file, keyed by
  // normalized path. runOneProposal re-anchors each proposed patch against
  // this content and refuses to ship one whose old-side doesn't match.
  const contentsByPath = new Map<string, string>();
  for (const f of args.changedFiles) {
    contentsByPath.set(normalizePath(f.filename), f.contents);
  }

  const calls: Array<Promise<ProviderPatchProposal>> = [];
  for (const [index, finding] of args.findings.entries()) {
    const findingId = args.findingIds[index];
    if (findingId === undefined) continue;
    for (const provider of args.providers) {
      calls.push(
        runOneProposal({
          provider,
          finding,
          findingId,
          hunksByPath,
          changedPaths,
          contentsByPath,
          model: args.model ?? null,
          timeoutMs,
        }),
      );
    }
  }

  const proposals = await Promise.all(calls);
  return { proposals, elapsedMs: now() - t0 };
}

type RunOneProposalArgs = {
  provider: PatchProposingProvider;
  finding: Finding;
  findingId: string;
  hunksByPath: Map<string, HunkRange[]>;
  changedPaths: ReadonlySet<string>;
  // Real source contents of each changed file, keyed by normalized path.
  // Drives the always-on apply-floor: a proposed patch whose old-side block
  // can't be located in the real file is a hallucination and never ships.
  contentsByPath: ReadonlyMap<string, string>;
  model: string | null;
  timeoutMs: number;
};

async function runOneProposal(args: RunOneProposalArgs): Promise<ProviderPatchProposal> {
  // Step 1: precheck — if the finding has no in-hunk evidence, skip the API
  // call entirely. Saves tokens + latency on every "file-level" finding.
  // No call → no token spend → usage: null (the cost layer reads null as $0
  // for this provider/finding pair, which is correct: nothing was billed).
  const evidence = args.finding.evidence[0];
  if (evidence === undefined) {
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: null,
      skipReason: "outside_diff_hunk",
      rationale: null,
      usage: null,
    };
  }
  const normalized = normalizePath(evidence.path);
  const hunks = args.hunksByPath.get(normalized) ?? [];
  const evidenceOverlapsHunk = rangeOverlapsHunk(hunks, evidence.startLine, evidence.endLine);
  if (!evidenceOverlapsHunk && !args.changedPaths.has(normalized)) {
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: null,
      skipReason: "outside_diff_hunk",
      rationale: null,
      usage: null,
    };
  }
  const mode = evidenceOverlapsHunk ? "inline" : "artifact";

  // Step 2: make the provider call with a hard timeout. Feed the model the
  // REAL source window around the evidence so it writes the diff's old-side
  // against actual code instead of reconstructing it from the finding prose —
  // the latter is the documented hallucination source (patches anchored to
  // code that doesn't exist, failing `git apply`).
  const sourceExcerpt = (() => {
    const fc = args.contentsByPath.get(normalized);
    return fc === undefined ? null : extractSourceWindow(fc, evidence.startLine, evidence.endLine);
  })();
  let raw: PatchSuggestionResult;
  try {
    raw = await withTimeout(
      args.provider.proposePatch(
        ".",
        buildPatchPrompt(args.finding, mode, sourceExcerpt),
        args.model,
      ),
      args.timeoutMs,
    );
  } catch {
    // A throw/timeout means the call may have burned tokens upstream, but we
    // never received the usage block — record null (cost-unknown) rather than
    // fabricate a number. The reconciliation cron can backfill via heuristic.
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: null,
      skipReason: "generation_error",
      rationale: null,
      usage: null,
    };
  }

  // Step 3: post-call validation. The call completed, so carry its real
  // token usage through regardless of whether the patch ultimately ships —
  // a declined or oversize patch still cost tokens to produce.
  if (raw.patch === null) {
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: raw.modelId,
      skipReason: null,
      rationale: raw.rationale,
      usage: raw.usage ?? null,
    };
  }
  const addedLines = countAddedLines(raw.patch);
  if (addedLines === 0) {
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: raw.modelId,
      skipReason: "outside_diff_hunk",
      rationale: raw.rationale,
      usage: raw.usage ?? null,
    };
  }
  if (addedLines > PATCH_SIZE_LINE_CAP) {
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: raw.modelId,
      skipReason: "size_cap",
      rationale: raw.rationale,
      usage: raw.usage ?? null,
    };
  }
  const targetable =
    mode === "inline"
      ? patchFallsInsideHunks(raw.patch, hunks, normalized, evidence.startLine, evidence.endLine)
      : patchTargetsFinding(raw.patch, normalized, evidence.startLine, evidence.endLine);
  if (!targetable) {
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: raw.modelId,
      skipReason: "outside_diff_hunk",
      rationale: raw.rationale,
      usage: raw.usage ?? null,
    };
  }

  // Step 4: apply-floor (always-on). The `targetable` check above only proves
  // the patch AIMS at the right line range — it never checks the diff's
  // old-side actually MATCHES the real file. A hallucinated/stale old-side
  // (editing code that doesn't exist) sails through targeting yet fails
  // `git apply` (exit 128) and, on repos without a test runner, ships as an
  // "unverified" suggestion. normalizePatchForApply locates the old-side
  // block inside the real source and re-anchors it: {ok:false} is the
  // hallucination signal; {ok:true} returns a clean, applicable diff (also
  // fixing applicable-but-malformed whitespace/line-count drift).
  const shippablePatch = (() => {
    const fileContents = args.contentsByPath.get(normalized);
    if (fileContents === undefined) {
      // Edge: evidence file wasn't in the changed set, so we have no real
      // source to verify against. Keep prior behavior and ship raw.patch;
      // applicability can't be checked here.
      return { ok: true as const, patch: raw.patch };
    }
    const res = normalizePatchForApply({
      patch: raw.patch,
      evidencePath: evidence.path,
      fileContents,
    });
    if (!res.ok) return { ok: false as const };
    return { ok: true as const, patch: res.patch };
  })();
  if (!shippablePatch.ok) {
    return {
      providerName: args.provider.name,
      findingId: args.findingId,
      patch: null,
      modelId: raw.modelId,
      skipReason: "patch_apply_failed",
      rationale: raw.rationale,
      usage: raw.usage ?? null,
    };
  }

  return {
    providerName: args.provider.name,
    findingId: args.findingId,
    patch: shippablePatch.patch,
    modelId: raw.modelId,
    skipReason: null,
    rationale: raw.rationale,
    usage: raw.usage ?? null,
  };
}

type PatchPromptMode = "inline" | "artifact";

function patchFallsInsideHunks(
  patch: string,
  hunks: readonly HunkRange[],
  expectedPath: string,
  evidenceStartLine: number | null,
  evidenceEndLine: number | null,
): boolean {
  if (!patchTargetsExpectedPath(patch, expectedPath)) return false;
  const patchHunks = parseHunkRanges(patch);
  if (patchHunks.length !== 1) return false;
  const [patchHunk] = patchHunks;
  if (patchHunk === undefined) return false;
  return (
    rangeFallsInsideHunk(hunks, patchHunk.start, patchHunk.end) &&
    rangeOverlapsHunk(
      [{ start: patchHunk.start, end: patchHunk.end }],
      evidenceStartLine,
      evidenceEndLine,
    )
  );
}

function patchTargetsExpectedPath(patch: string, expectedPath: string): boolean {
  const paths = parsePatchNewPaths(patch);
  if (paths.length === 0) return true;
  return paths.length === 1 && paths[0] === expectedPath;
}

function parsePatchNewPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const rawPath = line.slice(4);
    const tabIndex = rawPath.indexOf("\t");
    const path = tabIndex === -1 ? rawPath : rawPath.slice(0, tabIndex);
    paths.push(normalizeDiffPath(path.trim()));
  }
  return paths;
}

function normalizeDiffPath(path: string): string {
  if (path === "/dev/null") return path;
  return normalizePath(path.replace(/^[ab]\//u, ""));
}

function buildHunkIndex(files: readonly ChangedFile[]): Map<string, HunkRange[]> {
  const index = new Map<string, HunkRange[]>();
  for (const f of files) {
    index.set(normalizePath(f.filename), parseHunkRanges(f.patch));
  }
  return index;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

// How many lines of real source to show on each side of the evidence, and a
// hard char cap so the prompt stays bounded on large files. The apply-floor
// re-anchors the patch, so exact @@ line numbers aren't load-bearing — the
// window only needs to contain the lines the model will copy as old-side.
const PATCH_SOURCE_WINDOW_LINES = 40;
const PATCH_SOURCE_MAX_CHARS = 12_000;

export type SourceExcerpt = { text: string; firstLine: number };

// Extract the real source window around the evidence lines so the patch model
// diffs against actual code. Returns null when there's nothing to show.
export function extractSourceWindow(
  fileContents: string,
  startLine: number | null,
  endLine: number | null,
): SourceExcerpt | null {
  if (fileContents.length === 0) return null;
  const lines = fileContents.split("\n");
  const anchorStart = startLine === null || startLine <= 0 ? 1 : startLine;
  const anchorEnd = endLine === null || endLine < anchorStart ? anchorStart : endLine;
  const from = Math.max(1, anchorStart - PATCH_SOURCE_WINDOW_LINES);
  const to = Math.min(lines.length, anchorEnd + PATCH_SOURCE_WINDOW_LINES);
  let text = lines.slice(from - 1, to).join("\n");
  if (text.length > PATCH_SOURCE_MAX_CHARS) text = text.slice(0, PATCH_SOURCE_MAX_CHARS);
  return { text, firstLine: from };
}

// Prompt for the proposePatch call. Embeds the REAL source window (when
// available) so the model copies the diff's old-side verbatim instead of
// reconstructing the code from the finding prose — the historical
// hallucination source. Falls back gracefully when the excerpt is absent.
export function buildPatchPrompt(
  finding: Finding,
  mode: PatchPromptMode = "inline",
  sourceExcerpt: SourceExcerpt | null = null,
): string {
  const ev = finding.evidence[0];
  const target = ev === undefined ? "(unknown)" : formatEvidencePath(ev);
  const reproduction = finding.reproduction === null ? "(none provided)" : finding.reproduction;
  const artifactMode = mode === "artifact";
  const sourceBlock =
    sourceExcerpt === null
      ? []
      : [
          `SOURCE — exact current contents of ${target} (starting at line ${sourceExcerpt.firstLine}).`,
          `Copy the diff's old-side (context and removed lines) VERBATIM from this — do NOT paraphrase or reconstruct:`,
          "```",
          sourceExcerpt.text,
          "```",
          ``,
        ];
  return [
    `You previously flagged a ${finding.category} (${finding.severity}) finding titled:`,
    `  ${finding.title}`,
    ``,
    `Target: ${target}`,
    ``,
    `Reasoning: ${finding.reasoning}`,
    `Recommendation: ${finding.recommendation}`,
    `Reproduction: ${reproduction}`,
    ``,
    ...sourceBlock,
    artifactMode
      ? `Propose a SINGLE-FILE unified-diff patch artifact that fixes this finding.`
      : `Propose a SINGLE-FILE unified-diff patch that fixes this finding.`,
    ``,
    `Hard rules:`,
    sourceExcerpt === null
      ? `  1. (source not shown — decline with patch=null unless the fix is unambiguous)`
      : `  1. Every context and removed (' '/'-') line in your diff MUST appear VERBATIM in SOURCE above. If the code needing the change isn't shown, return patch=null. Do not invent surrounding code.`,
    `  2. Output ≤ ${PATCH_SIZE_LINE_CAP} added lines total.`,
    artifactMode
      ? `  3. The patch may target this file outside the PR diff hunk; it will be rendered as a non-click-to-apply artifact.`
      : `  3. The patch must target lines INSIDE the PR's diff hunks for this file.`,
    `  4. If no clean fix fits within those rules, return { "patch": null,`,
    `     "rationale": "<one sentence on WHY a patch is impossible>" }.`,
    `     The rationale must explain WHY a localized fix cannot be written`,
    `     (e.g. "needs changes in 3 other files", "requires architectural`,
    `     refactor", "exceeds ${PATCH_SIZE_LINE_CAP}-line cap"). It MUST NOT`,
    `     describe what the patch would do. If you can describe a fix in one`,
    `     sentence and it fits rules 1–3, you have enough certainty — write`,
    `     the unified diff instead of declining.`,
    `  5. Do NOT propose deferred fixes. Never output TODO comments, "fix in a follow-up",`,
    `     or "address in a later PR". Either ship a minimal in-scope patch now, or return`,
    `     patch=null with a concrete skip reason (needs architectural change, unsafe without`,
    `     more context, exceeds line cap). Deferral is not a valid patch outcome.`,
    ``,
    `Return JSON: { "patch": "<unified-diff or null>", "rationale": "<string or null>" }.`,
  ].join("\n");
}

function patchTargetsFinding(
  patch: string,
  expectedPath: string,
  evidenceStartLine: number | null,
  evidenceEndLine: number | null,
): boolean {
  if (!patchTargetsExpectedPath(patch, expectedPath)) return false;
  if (evidenceStartLine === null) return true;
  const patchHunks = parseHunkRanges(patch);
  if (patchHunks.length !== 1) return false;
  const [patchHunk] = patchHunks;
  if (patchHunk === undefined) return false;
  return rangeOverlapsHunk(
    [{ start: patchHunk.start, end: patchHunk.end }],
    evidenceStartLine,
    evidenceEndLine,
  );
}

function formatEvidencePath(ev: NonNullable<Finding["evidence"][number]>): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`patch generation exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
}
