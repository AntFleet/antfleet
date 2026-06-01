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
  type HunkRange,
} from "./diff-hunks";
import type { PatchSuggestionResult } from "@antfleet/cli/types";
import type { PatchSkipReason, ProviderPatchProposal } from "@antfleet/cli/providers/patch-gate";

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
  if (!rangeFallsInsideHunk(hunks, evidence.startLine, evidence.endLine)) {
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

  // Step 2: make the provider call with a hard timeout.
  let raw: PatchSuggestionResult;
  try {
    raw = await withTimeout(
      args.provider.proposePatch(".", buildPatchPrompt(args.finding), args.model),
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
  if (countAddedLines(raw.patch) > PATCH_SIZE_LINE_CAP) {
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
  return {
    providerName: args.provider.name,
    findingId: args.findingId,
    patch: raw.patch,
    modelId: raw.modelId,
    skipReason: null,
    rationale: raw.rationale,
    usage: raw.usage ?? null,
  };
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

// Prompt for the proposePatch call. Intentionally compact — the model has
// already produced this finding once; we don't re-narrate the codebase, just
// ask for the patch. Falls back gracefully when reproduction is absent.
export function buildPatchPrompt(finding: Finding): string {
  const ev = finding.evidence[0];
  const target = ev === undefined ? "(unknown)" : formatEvidencePath(ev);
  const reproduction = finding.reproduction === null ? "(none provided)" : finding.reproduction;
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
    `Propose a SINGLE-FILE unified-diff patch that fixes this finding.`,
    ``,
    `Hard rules:`,
    `  1. Output ≤ ${PATCH_SIZE_LINE_CAP} added lines total.`,
    `  2. The patch must target lines INSIDE the PR's diff hunks for this file.`,
    `  3. If no clean fix fits within those rules, return { "patch": null,`,
    `     "rationale": "<one sentence on why" }.`,
    `  4. Do NOT propose deferred fixes. Never output TODO comments, "fix in a follow-up",`,
    `     or "address in a later PR". Either ship a minimal in-scope patch now, or return`,
    `     patch=null with a concrete skip reason (needs architectural change, unsafe without`,
    `     more context, exceeds line cap). Deferral is not a valid patch outcome.`,
    ``,
    `Return JSON: { "patch": "<unified-diff or null>", "rationale": "<string or null>" }.`,
  ].join("\n");
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
