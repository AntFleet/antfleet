import { Octokit } from "@octokit/rest";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db/index";
import { outgoingPrs } from "@/db/schema";
import { logError, logInfo, logWarn } from "./log";
import { writePostDraft } from "./post-drafts";
import {
  detectAbsorbedInline,
  realAbsorbedInlineDeps,
  type AbsorbedInlineResult,
} from "./absorbed-inline";

// Cross-repo receipts — Slice B of Phase-2 receipt density work.
//
// AntFleet's GitHub App is not installed on third-party repos where
// antfleet-ops opens upstream PRs. The standard sweep (finding_status →
// reviews) is therefore blind to those PRs' merge state. This module
// is the parallel data path: rows in outgoing_prs are seeded by an
// operator script when an upstream PR is opened, then this poll loop
// runs on the cron tick to transition status open → merged | closed.
// Merged rows surface on /receipts as cross-repo receipts; declined
// rows are logged only (honest-report: a closed-without-merge PR is
// not a receipt).
//
// The poll rate limit (one hour per row) is two things at once: a
// politeness budget toward the upstream owner's GitHub rate limit, and
// a guard on antfleet-ops's PAT which is shared with manual `gh` work.

const POLL_INTERVAL_MS = 60 * 60 * 1000;

export type OpenOutgoingPr = {
  id: string;
  upstreamOwner: string;
  upstreamRepo: string;
  upstreamPrNumber: number;
  openedAt: Date;
  branchOnFork: string;
};

export type UpstreamPrState = {
  // True only when GitHub returned a non-null merged_at. A PR can be
  // closed without merging — in which case merged_at is null and
  // state === "closed".
  merged: boolean;
  mergedAt: Date | null;
  mergeSha: string | null;
  // The raw GitHub `state` field: "open" or "closed".
  state: "open" | "closed";
};

export type PollOutgoingDeps = {
  loadOpenPrs: (now: Date) => Promise<OpenOutgoingPr[]>;
  getUpstreamPrState: (args: {
    owner: string;
    repo: string;
    number: number;
  }) => Promise<UpstreamPrState>;
  markMerged: (args: {
    id: string;
    mergedAt: Date;
    mergeSha: string;
    polledAt: Date;
  }) => Promise<void>;
  markClosed: (args: { id: string; polledAt: Date }) => Promise<void>;
  markAbsorbed: (args: {
    id: string;
    closureSha: string;
    closureConfidence: number;
    closureNotes: string;
    polledAt: Date;
  }) => Promise<void>;
  detectAbsorbed: (pr: OpenOutgoingPr) => Promise<AbsorbedInlineResult>;
  stampPolled: (args: { id: string; polledAt: Date }) => Promise<void>;
};

export type PollOutgoingResult = {
  attempted: number;
  merged: number;
  closed: number;
  absorbed: number;
  unchanged: number;
  errors: number;
};

export async function pollOutgoingPrs(
  deps: PollOutgoingDeps,
  now: Date = new Date(),
): Promise<PollOutgoingResult> {
  const open = await deps.loadOpenPrs(now);
  let merged = 0;
  let closed = 0;
  let absorbed = 0;
  let unchanged = 0;
  let errors = 0;
  for (const pr of open) {
    try {
      const state = await deps.getUpstreamPrState({
        owner: pr.upstreamOwner,
        repo: pr.upstreamRepo,
        number: pr.upstreamPrNumber,
      });
      if (state.merged && state.mergedAt !== null && state.mergeSha !== null) {
        await deps.markMerged({
          id: pr.id,
          mergedAt: state.mergedAt,
          mergeSha: state.mergeSha,
          polledAt: now,
        });
        merged += 1;
        logInfo("outgoing_prs.merged", {
          id: pr.id,
          upstream: `${pr.upstreamOwner}/${pr.upstreamRepo}#${pr.upstreamPrNumber}`,
          mergeSha: state.mergeSha,
        });
      } else if (state.merged) {
        // GitHub returned merged=true but merge_commit_sha is still null
        // (async commit propagation can lag the API's `merged` flag by
        // seconds-to-minutes). Treat as still-open and re-poll next tick
        // rather than mis-marking as declined — a merged PR is the
        // receipt-eligible class and we don't want to lose it.
        await deps.stampPolled({ id: pr.id, polledAt: now });
        unchanged += 1;
        logWarn("outgoing_prs.merged_pending_sha", {
          id: pr.id,
          upstream: `${pr.upstreamOwner}/${pr.upstreamRepo}#${pr.upstreamPrNumber}`,
        });
      } else if (state.state === "closed") {
        // Closed without merge — run absorbed-inline detection before
        // classifying. The LLM judge compares our PR diff against recent
        // upstream commits to see if the fix landed independently.
        const detection = await deps.detectAbsorbed(pr);
        if (detection.absorbed) {
          await deps.markAbsorbed({
            id: pr.id,
            closureSha: detection.commitSha,
            closureConfidence: detection.confidence,
            closureNotes: detection.reasoning,
            polledAt: now,
          });
          absorbed += 1;
          logInfo("outgoing_prs.absorbed_inline", {
            id: pr.id,
            upstream: `${pr.upstreamOwner}/${pr.upstreamRepo}#${pr.upstreamPrNumber}`,
            closureSha: detection.commitSha,
            confidence: detection.confidence,
          });
        } else {
          await deps.markClosed({ id: pr.id, polledAt: now });
          closed += 1;
          logInfo("outgoing_prs.declined", {
            id: pr.id,
            upstream: `${pr.upstreamOwner}/${pr.upstreamRepo}#${pr.upstreamPrNumber}`,
          });
        }
      } else {
        await deps.stampPolled({ id: pr.id, polledAt: now });
        unchanged += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn("outgoing_prs.poll_failed", {
        id: pr.id,
        upstream: `${pr.upstreamOwner}/${pr.upstreamRepo}#${pr.upstreamPrNumber}`,
        message,
      });
      errors += 1;
    }
  }
  return { attempted: open.length, merged, closed, absorbed, unchanged, errors };
}

// ─── Real-deps wiring (used by cron sweep) ─────────────────────────────────

function getAntfleetOpsToken(): string {
  const token = process.env["ANTFLEET_OPS_GH_TOKEN"];
  if (token === undefined || token.length === 0) {
    throw new Error("ANTFLEET_OPS_GH_TOKEN is required to poll outgoing PRs");
  }
  return token;
}

export function realPollDeps(): PollOutgoingDeps {
  // Lazy Octokit construction so the cron route only instantiates when
  // there's actually work to do. Token is read each call so a rotated
  // PAT picks up without a deploy.
  const tokenReader = () => new Octokit({ auth: getAntfleetOpsToken() });
  return {
    loadOpenPrs: async (now: Date) => {
      const threshold = new Date(now.getTime() - POLL_INTERVAL_MS);
      const rows = await db
        .select({
          id: outgoingPrs.id,
          upstreamOwner: outgoingPrs.upstreamOwner,
          upstreamRepo: outgoingPrs.upstreamRepo,
          upstreamPrNumber: outgoingPrs.upstreamPrNumber,
          openedAt: outgoingPrs.openedAt,
          branchOnFork: outgoingPrs.branchOnFork,
        })
        .from(outgoingPrs)
        .where(
          and(
            eq(outgoingPrs.status, "open"),
            or(isNull(outgoingPrs.lastPolledAt), lt(outgoingPrs.lastPolledAt, threshold)),
          ),
        );
      return rows;
    },
    getUpstreamPrState: async ({ owner, repo, number }) => {
      const octokit = tokenReader();
      const resp = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
      });
      const data = resp.data;
      const mergedAt = data.merged_at !== null ? new Date(data.merged_at) : null;
      const merged = data.merged === true && mergedAt !== null;
      // GitHub's `state` for pulls is "open" | "closed"; we never
      // expect anything else but tighten via a fallback to "open".
      const state: "open" | "closed" = data.state === "closed" ? "closed" : "open";
      return {
        merged,
        mergedAt,
        mergeSha: data.merge_commit_sha ?? null,
        state,
      };
    },
    markMerged: async ({ id, mergedAt, mergeSha, polledAt }) => {
      const rows = await db
        .update(outgoingPrs)
        .set({
          status: "merged",
          mergedAt,
          mergeSha,
          lastPolledAt: polledAt,
          closureMethod: "merged",
          closureSha: mergeSha,
          closureDetectedAt: polledAt,
        })
        .where(eq(outgoingPrs.id, id))
        .returning({
          upstreamOwner: outgoingPrs.upstreamOwner,
          upstreamRepo: outgoingPrs.upstreamRepo,
          upstreamPrNumber: outgoingPrs.upstreamPrNumber,
        });
      if (rows[0] !== undefined) {
        const row = rows[0];
        try {
          await writePostDraft({
            slug: `outgoing-pr-merged-${row.upstreamOwner}-${row.upstreamRepo}-${row.upstreamPrNumber}`,
            title: "Outgoing PR merged",
            body: `${row.upstreamOwner}/${row.upstreamRepo}#${row.upstreamPrNumber} merged at ${mergeSha} on ${mergedAt.toISOString()}.`,
          });
        } catch (err) {
          logWarn("outgoing_prs.post_draft_failed", {
            event: "merged",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    markClosed: async ({ id, polledAt }) => {
      const rows = await db
        .update(outgoingPrs)
        .set({
          status: "closed",
          lastPolledAt: polledAt,
          closureMethod: "declined",
          closureDetectedAt: polledAt,
        })
        .where(eq(outgoingPrs.id, id))
        .returning({
          upstreamOwner: outgoingPrs.upstreamOwner,
          upstreamRepo: outgoingPrs.upstreamRepo,
          upstreamPrNumber: outgoingPrs.upstreamPrNumber,
        });
      if (rows[0] !== undefined) {
        const row = rows[0];
        try {
          await writePostDraft({
            slug: `outgoing-pr-closed-${row.upstreamOwner}-${row.upstreamRepo}-${row.upstreamPrNumber}`,
            title: "Outgoing PR closed",
            body: `${row.upstreamOwner}/${row.upstreamRepo}#${row.upstreamPrNumber} closed without merge at ${polledAt.toISOString()}.`,
          });
        } catch (err) {
          logWarn("outgoing_prs.post_draft_failed", {
            event: "closed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    markAbsorbed: async ({ id, closureSha, closureConfidence, closureNotes, polledAt }) => {
      const rows = await db
        .update(outgoingPrs)
        .set({
          status: "closed_absorbed",
          lastPolledAt: polledAt,
          closureMethod: "absorbed_inline",
          closureSha,
          closureDetectedAt: polledAt,
          closureConfidence,
          closureNotes,
        })
        .where(eq(outgoingPrs.id, id))
        .returning({
          upstreamOwner: outgoingPrs.upstreamOwner,
          upstreamRepo: outgoingPrs.upstreamRepo,
          upstreamPrNumber: outgoingPrs.upstreamPrNumber,
        });
      if (rows[0] !== undefined) {
        const row = rows[0];
        try {
          await writePostDraft({
            slug: `outgoing-pr-absorbed-${row.upstreamOwner}-${row.upstreamRepo}-${row.upstreamPrNumber}`,
            title: "Outgoing PR absorbed inline",
            body: `${row.upstreamOwner}/${row.upstreamRepo}#${row.upstreamPrNumber} fix absorbed via upstream commit ${closureSha.slice(0, 7)} (confidence: ${closureConfidence.toFixed(2)}).`,
          });
        } catch (err) {
          logWarn("outgoing_prs.post_draft_failed", {
            event: "absorbed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    detectAbsorbed: async (pr: OpenOutgoingPr) => {
      const absorbedDeps = realAbsorbedInlineDeps();
      return detectAbsorbedInline(pr, absorbedDeps);
    },
    stampPolled: async ({ id, polledAt }) => {
      await db.update(outgoingPrs).set({ lastPolledAt: polledAt }).where(eq(outgoingPrs.id, id));
    },
  };
}

// Display loader + URL helper for cross-repo receipts live in lib/receipts.ts
// alongside the same-repo loaders. This module owns the write/poll path
// only; readers import from lib/receipts.ts.

// Wrapping for the cron tick — never throw out of the poll loop. The
// cron handler treats sweep success as the load-bearing outcome; an
// outgoing-PR poll failure logs and continues.
export async function runOutgoingPrsPoll(): Promise<PollOutgoingResult | null> {
  try {
    const deps = realPollDeps();
    return await pollOutgoingPrs(deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("outgoing_prs.poll_orchestrator_failed", { message });
    return null;
  }
}
