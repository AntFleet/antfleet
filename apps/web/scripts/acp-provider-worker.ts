#!/usr/bin/env tsx
// Drain Virtuals ACP CLI events into AntFleet's existing review_jobs worker.
//
// Run alongside:
//   acp events listen --output .acp/events.jsonl --json
//
// Then invoke this script periodically or as a lightweight loop:
//   pnpm --dir apps/web exec tsx scripts/acp-provider-worker.ts --file .acp/events.jsonl

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import type { recordAcpProviderEvent } from "@/lib/acp/event-inbox";
import { messageOf } from "../lib/log";

loadDotenv({ path: ".env.local", quiet: true });

const execFileAsync = promisify(execFile);
type AcpInboxDb = Parameters<typeof recordAcpProviderEvent>[0];
type ReviewJobDb = Parameters<typeof import("@/lib/review-job-queries").findStaleQueuedJobs>[0];
type ReviewJobQueries = Pick<
  typeof import("@/lib/review-job-queries"),
  "findStaleQueuedJobs" | "findStuckRunningJobs"
>;
type ReviewJobWorker = Pick<
  typeof import("@/lib/review-job-worker"),
  "processReviewJob" | "terminalizeAcpJobFailure"
>;

const ORPHAN_THRESHOLD_MS = 60 * 1000;
const STUCK_THRESHOLD_MS = 600 * 1000;

async function main() {
  const file = readFlag("--file") ?? process.env["ACP_EVENTS_FILE"] ?? ".acp/events.jsonl";
  const limit = readFlag("--limit") ?? "20";
  const retryLimit = Number(readFlag("--retry-limit") ?? "20");
  const lines = await drainEventLines(file, limit);
  const [{ db }, inboxModule, reviewJobQueries, reviewJobWorker] = await Promise.all([
    import("@/db"),
    import("@/lib/acp/event-inbox"),
    import("@/lib/review-job-queries"),
    import("@/lib/review-job-worker"),
  ]);
  const { handleAcpProviderEvent } = await import("@/lib/acp/intake-adapter");
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      console.error(JSON.stringify({ event: "malformed_json", message: messageOf(err) }));
      continue;
    }

    const inbox = await inboxModule.recordAcpProviderEvent(db, event);
    await processInboxEvent({
      db,
      inboxModule,
      handleAcpProviderEvent,
      event,
      eventKey: inbox.eventKey,
      skipIfProcessed: !inbox.created && inbox.status === "processed",
    });
  }

  const retryEvents = await inboxModule.findDueAcpProviderEvents(
    db,
    new Date(),
    Number.isFinite(retryLimit) ? retryLimit : 20,
  );
  for (const retry of retryEvents) {
    await processInboxEvent({
      db,
      inboxModule,
      handleAcpProviderEvent,
      event: retry.payload,
      eventKey: retry.eventKey,
      skipIfProcessed: false,
    });
  }

  const recovery = await recoverAcpReviewJobs({
    db,
    reviewJobQueries,
    reviewJobWorker,
    now: new Date(),
  });
  if (recovery.orphansRetriggered > 0 || recovery.stuckTimedOut > 0) {
    console.log(JSON.stringify({ event: "acp_recovery", outcome: recovery }));
  }
}

async function processInboxEvent(args: {
  db: AcpInboxDb;
  inboxModule: typeof import("@/lib/acp/event-inbox");
  handleAcpProviderEvent: typeof import("@/lib/acp/intake-adapter").handleAcpProviderEvent;
  event: Record<string, unknown>;
  eventKey: string;
  skipIfProcessed: boolean;
}): Promise<void> {
  const { db, inboxModule, handleAcpProviderEvent, event, eventKey } = args;
  if (args.skipIfProcessed) {
    console.log(
      JSON.stringify({
        event: event.type ?? event.event ?? "unknown",
        acpJobId: event.jobId ?? event.job_id ?? null,
        outcome: { ignored: "duplicate_processed_event" },
      }),
    );
    return;
  }
  const claimed = await inboxModule.claimAcpProviderEvent(db, eventKey, new Date());
  if (!claimed) {
    console.log(
      JSON.stringify({
        event: event.type ?? event.event ?? "unknown",
        acpJobId: event.jobId ?? event.job_id ?? null,
        outcome: { ignored: "event_not_claimed" },
      }),
    );
    return;
  }
  try {
    const outcome = await handleAcpProviderEvent(event);
    await inboxModule.markAcpProviderEventProcessed(db, eventKey, new Date());
    console.log(
      JSON.stringify({
        event: event.type ?? event.event ?? "unknown",
        acpJobId: event.jobId ?? event.job_id ?? null,
        outcome: summarizeAcpOutcome(outcome),
      }),
    );
  } catch (err) {
    await inboxModule.markAcpProviderEventFailed(db, eventKey, messageOf(err), new Date());
    console.error(
      JSON.stringify({
        event: event.type ?? event.event ?? "unknown",
        acpJobId: event.jobId ?? event.job_id ?? null,
        error: safeAcpProviderWorkerErrorSummary(err),
      }),
    );
  }
}

function summarizeAcpOutcome(outcome: unknown): Record<string, unknown> {
  if (typeof outcome !== "object" || outcome === null) return { status: "unknown" };
  const record = outcome as Record<string, unknown>;
  if ("ignored" in record) return { ignored: record["ignored"] };

  const job =
    typeof record["job"] === "object" && record["job"] !== null
      ? (record["job"] as Record<string, unknown>)
      : null;
  if ("created" in record) {
    return {
      kind: "job_created",
      antfleetJobId: job?.["jobId"],
      created: record["created"],
      status: job?.["status"],
      budgetStatus: job?.["acpBudgetStatus"],
      budgetSet: record["budget"] !== null && record["budget"] !== undefined,
    };
  }
  if ("queued" in record) {
    const worker =
      typeof record["worker"] === "object" && record["worker"] !== null
        ? (record["worker"] as Record<string, unknown>)
        : null;
    return {
      kind: "job_funded",
      antfleetJobId: job?.["jobId"],
      queued: record["queued"],
      status: job?.["status"],
      workerKind: worker?.["kind"] ?? null,
      workerReason: worker?.["reason"] ?? null,
    };
  }
  return { status: "unknown" };
}

async function drainEventLines(file: string, limit: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "acp",
    ["events", "drain", "--file", file, "--limit", limit],
    {
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function recoverAcpReviewJobs(args: {
  db: ReviewJobDb;
  reviewJobQueries: ReviewJobQueries;
  reviewJobWorker: ReviewJobWorker;
  now?: Date;
}): Promise<{ orphansRetriggered: number; stuckTimedOut: number }> {
  const now = args.now ?? new Date();
  const orphanThreshold = new Date(now.getTime() - ORPHAN_THRESHOLD_MS);
  const stuckThreshold = new Date(now.getTime() - STUCK_THRESHOLD_MS);
  let orphansRetriggered = 0;
  let stuckTimedOut = 0;

  const orphans = await args.reviewJobQueries.findStaleQueuedJobs(args.db, orphanThreshold);
  for (const orphan of orphans) {
    if (orphan.paymentRail !== "acp") continue;
    const outcome = await args.reviewJobWorker.processReviewJob(orphan.jobId);
    if (outcome.kind !== "skipped" || outcome.reason !== "status_is_running") {
      orphansRetriggered++;
    }
  }

  const stuck = await args.reviewJobQueries.findStuckRunningJobs(args.db, stuckThreshold);
  for (const job of stuck) {
    if (job.paymentRail !== "acp") continue;
    await args.reviewJobWorker.terminalizeAcpJobFailure({
      job,
      jobId: job.jobId,
      failureMode: "timeout",
      publicMessage: "review exceeded 10-minute timeout",
      rawMessage: "ACP provider worker timed out a stuck ACP job",
    });
    stuckTimedOut++;
  }

  return { orphansRetriggered, stuckTimedOut };
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

export function safeAcpProviderWorkerErrorSummary(err: unknown): Record<string, string> {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : "provider worker failed";
  return {
    name: safeErrorName(name),
    message: safeErrorMessage(message),
  };
}

function safeErrorName(name: string): string {
  if (/^[A-Za-z0-9_.-]{1,80}$/.test(name)) return name;
  return "Error";
}

function safeErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("stdout") ||
    lower.includes("stderr") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("private") ||
    lower.includes("authorization")
  ) {
    return "provider worker failed";
  }
  return message.slice(0, 200);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        event: "acp_provider_worker_fatal",
        error: safeAcpProviderWorkerErrorSummary(err),
      }),
    );
    process.exit(1);
  });
}
