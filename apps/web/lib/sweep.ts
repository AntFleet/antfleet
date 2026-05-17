import type {
  ClosureDecision,
  FindingForClosureCheck,
} from "./sweeper";
import { detectClosures as detectClosuresImpl } from "./sweeper";
import {
  mapToMaintainerReactions,
  pollReactions as pollReactionsImpl,
  type RawReaction,
} from "./reactions";
import { formatClosureReceipt, postPRComment as postPRCommentImpl } from "./pr-comment";
import { extractFindingsByIndex } from "./sweep-data";
import {
  loadSweepWork as loadSweepWorkImpl,
  markFindingClosed as markFindingClosedImpl,
  recordMaintainerReactions as recordMaintainerReactionsImpl,
  stampFindingPolled as stampFindingPolledImpl,
  type SweepReviewBatch,
} from "../db/queries";
import type { NewMaintainerReaction } from "../db/schema";
import { messageOf } from "./log";

// Mission 3 slice 3-5 — the orchestrator. Composes every primitive shipped
// in slices 3-1 through 3-4 into one daily cron pass:
//   1. Closure pass — for each open finding, detect whether its evidence
//      file changed on main; if so, post a closure receipt and mark closed.
//   2. Reaction pass — for each finding still open with a posted comment,
//      poll the comment for maintainer reactions and record fresh ones.
//
// Dependencies are injected so the route handler can wire real impls and
// tests can wire mocks without touching DB or network. The default
// `runSweep()` (no deps arg) uses the real impls and is what the route calls.

// 30 days in ms — past this horizon, the reaction signal is stale enough
// that the cron cost outweighs the data value. AGENTS.md §10 names 30d as
// the outermost checkpoint; treating it as the polling cutoff means we
// keep capturing right up to that anchor without burning cycles past it.
const REACTION_POLL_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export type SweepError = {
  scope: "batch" | "closure" | "reaction";
  reviewId: string;
  findingId: string | null;
  message: string;
};

export type SweepResult = {
  swept: number;
  closed: number;
  reactionsRecorded: number;
  reviewsSkipped: number;
  errors: SweepError[];
};

export type SweepDeps = {
  loadSweepWork: typeof loadSweepWorkImpl;
  detectClosures: typeof detectClosuresImpl;
  postPRComment: typeof postPRCommentImpl;
  markFindingClosed: typeof markFindingClosedImpl;
  pollReactions: typeof pollReactionsImpl;
  recordMaintainerReactions: typeof recordMaintainerReactionsImpl;
  stampFindingPolled: typeof stampFindingPolledImpl;
  now: () => Date;
};

const REAL_DEPS: SweepDeps = {
  loadSweepWork: loadSweepWorkImpl,
  detectClosures: detectClosuresImpl,
  postPRComment: postPRCommentImpl,
  markFindingClosed: markFindingClosedImpl,
  pollReactions: pollReactionsImpl,
  recordMaintainerReactions: recordMaintainerReactionsImpl,
  stampFindingPolled: stampFindingPolledImpl,
  now: () => new Date(),
};

export async function runSweep(deps: SweepDeps = REAL_DEPS): Promise<SweepResult> {
  const result: SweepResult = {
    swept: 0,
    closed: 0,
    reactionsRecorded: 0,
    reviewsSkipped: 0,
    errors: [],
  };
  const batches = await deps.loadSweepWork();

  for (const batch of batches) {
    const findingsByIndex = extractFindingsByIndex(batch.agreementDecision);
    if (findingsByIndex === null) {
      // The agreement_decision JSONB is malformed or in a stub shape
      // (pending/skipped/error). Nothing to reconcile — record and move on.
      result.reviewsSkipped += 1;
      result.errors.push({
        scope: "batch",
        reviewId: batch.reviewId,
        findingId: null,
        message: "agreement_decision missing or malformed",
      });
      continue;
    }

    const closedThisBatch = new Set<string>();

    try {
      await runClosurePass(batch, findingsByIndex, deps, result, closedThisBatch);
    } catch (err) {
      result.errors.push({
        scope: "batch",
        reviewId: batch.reviewId,
        findingId: null,
        message: `closure pass: ${messageOf(err)}`,
      });
    }

    try {
      await runReactionPass(batch, deps, result, closedThisBatch);
    } catch (err) {
      result.errors.push({
        scope: "batch",
        reviewId: batch.reviewId,
        findingId: null,
        message: `reaction pass: ${messageOf(err)}`,
      });
    }

    result.swept += batch.findings.length;
  }

  return result;
}

async function runClosurePass(
  batch: SweepReviewBatch,
  findingsByIndex: ReadonlyMap<number, { evidence: { path: string }[] }>,
  deps: SweepDeps,
  result: SweepResult,
  closedThisBatch: Set<string>,
): Promise<void> {
  const closureInputs: FindingForClosureCheck[] = [];
  for (const f of batch.findings) {
    const finding = findingsByIndex.get(f.findingIndex);
    if (finding === undefined) continue;
    const evidencePath = finding.evidence[0]?.path;
    if (evidencePath === undefined) continue;
    closureInputs.push({ findingId: f.findingId, evidencePath });
  }
  if (closureInputs.length === 0) return;

  const decisions = await deps.detectClosures({
    installationId: batch.installationId,
    owner: batch.owner,
    repo: batch.repo,
    reviewCommitSha: batch.commitSha,
    findings: closureInputs,
  });

  for (const decision of decisions) {
    if (decision.status !== "closed") continue;
    try {
      await processClosure(decision, batch, findingsByIndex, deps);
      closedThisBatch.add(decision.findingId);
      result.closed += 1;
    } catch (err) {
      result.errors.push({
        scope: "closure",
        reviewId: batch.reviewId,
        findingId: decision.findingId,
        message: messageOf(err),
      });
    }
  }
}

async function processClosure(
  decision: Extract<ClosureDecision, { status: "closed" }>,
  batch: SweepReviewBatch,
  findingsByIndex: ReadonlyMap<number, unknown>,
  deps: SweepDeps,
): Promise<void> {
  const findingMeta = batch.findings.find((f) => f.findingId === decision.findingId);
  if (findingMeta === undefined) {
    throw new Error("finding meta missing from batch (impossible: input came from batch)");
  }
  const finding = findingsByIndex.get(findingMeta.findingIndex);
  if (finding === undefined) {
    throw new Error("finding payload missing from JSONB extraction map");
  }
  // Cast to the public Finding shape — extractFindingsByIndex already
  // validated the shape; the loose unknown is just to keep this fn callable
  // from runClosurePass without leaking the type into its signature.
  const body = formatClosureReceipt({
    findingId: decision.findingId,
    closureSha: decision.closureSha,
    finding: finding as Parameters<typeof formatClosureReceipt>[0]["finding"],
    owner: batch.owner,
    repo: batch.repo,
    originalCommentUrl: batch.prCommentUrl,
  });
  const posted = await deps.postPRComment({
    installationId: batch.installationId,
    owner: batch.owner,
    repo: batch.repo,
    prNumber: batch.prNumber,
    body,
  });
  await deps.markFindingClosed({
    findingId: decision.findingId,
    closureSha: decision.closureSha,
    closureCommentId: posted.id,
    closureCommentUrl: posted.htmlUrl,
  });
}

async function runReactionPass(
  batch: SweepReviewBatch,
  deps: SweepDeps,
  result: SweepResult,
  closedThisBatch: Set<string>,
): Promise<void> {
  if (batch.prCommentId === null) return;
  const now = deps.now();
  // All findings on a review share the same posted comment in v1
  // (slice 4c posts ONE comment per review). One fetch services every
  // finding's reactions for this batch.
  const eligible = batch.findings.filter(
    (f) =>
      !closedThisBatch.has(f.findingId) &&
      now.getTime() - f.createdAt.getTime() <= REACTION_POLL_HORIZON_MS,
  );
  if (eligible.length === 0) return;

  const rawReactions = await deps.pollReactions({
    installationId: batch.installationId,
    owner: batch.owner,
    repo: batch.repo,
    commentId: batch.prCommentId,
  });

  for (const f of eligible) {
    try {
      const rows: NewMaintainerReaction[] = mapToMaintainerReactions({
        reviewId: batch.reviewId,
        findingId: f.findingId,
        rawReactions,
      });
      const inserted = await deps.recordMaintainerReactions(rows);
      await deps.stampFindingPolled(f.findingId, now);
      result.reactionsRecorded += inserted;
    } catch (err) {
      result.errors.push({
        scope: "reaction",
        reviewId: batch.reviewId,
        findingId: f.findingId,
        message: messageOf(err),
      });
    }
  }
}

// Re-export so route handlers can import without reaching across files.
export type { RawReaction };
