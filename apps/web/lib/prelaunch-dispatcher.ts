import { asc, eq, isNull, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/db";
import { factoryLaunches, roastSubmissions, type FactoryLaunch } from "@/db/schema";
import { logError, logInfo, logWarn, messageOf } from "@/lib/log";
import { writeFactoryRepoFoundDraft, writeFactoryVerdictDraft } from "@/lib/post-drafts";
import { discoverRepoForAgent } from "@/lib/repo-discovery";
import type { RoastSubmissionStatus } from "@/lib/roast-status";

const DISCOVERY_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const PUBLIC_BASE_URL = (
  process.env["ANTFLEET_PUBLIC_BASE_URL"] ?? "https://www.antfleet.dev"
).replace(/\/+$/, "");

export type PrelaunchTickResult = {
  pendingProcessed: number;
  reposDiscovered: number;
  repoMisses: number;
  dispatched: number;
  publishedDetected: number;
};

export async function runPrelaunchOnce(): Promise<PrelaunchTickResult> {
  const t0 = Date.now();
  const result: PrelaunchTickResult = {
    pendingProcessed: 0,
    reposDiscovered: 0,
    repoMisses: 0,
    dispatched: 0,
    publishedDetected: 0,
  };

  // Gate on the same env var that controls poll-factory. Without an agents-
  // specific factory contract address, factory_launches rows can only be
  // garbage left from a prior misconfigured backfill (Sprint 3 sequel
  // 2026-05-19) and discoverRepoForAgent can false-positive on github_search
  // for completely unrelated repos. Refuse to publish under those conditions.
  if (
    process.env["AGENTS_FACTORY_ADDRESS"] === undefined ||
    process.env["AGENTS_FACTORY_ADDRESS"].length === 0
  ) {
    logInfo("prelaunch_dispatcher.skip", {
      reason: "AGENTS_FACTORY_ADDRESS not set",
    });
    return result;
  }

  await processPending(result);
  await processBenchmarking(result);

  logInfo("prelaunch_dispatcher.tick", {
    ...result,
    elapsedMs: Date.now() - t0,
  });
  return result;
}

async function processPending(result: PrelaunchTickResult): Promise<void> {
  const pending = await db
    .select()
    .from(factoryLaunches)
    .where(eq(factoryLaunches.prelaunchStatus, "pending"))
    .orderBy(asc(factoryLaunches.deployedAt));

  for (const launch of pending) {
    result.pendingProcessed += 1;
    try {
      await processOnePending(launch, result);
    } catch (err) {
      // Per-row failures shouldn't poison the tick; the cron will re-attempt
      // next interval. Log + continue.
      logError("prelaunch_dispatcher.row_failed", {
        tokenAddress: launch.tokenAddress,
        message: messageOf(err),
      });
    }
  }
}

async function processOnePending(
  launch: FactoryLaunch,
  result: PrelaunchTickResult,
): Promise<void> {
  let repoFullName = launch.repoFullName;
  let method = launch.repoDiscoveryMethod;

  if (repoFullName === null) {
    const ageMs = Date.now() - launch.observedAt.getTime();
    if (ageMs > DISCOVERY_TIMEOUT_MS) {
      await transitionStatus(launch.tokenAddress, "pending", "repo_not_found");
      logWarn("prelaunch_dispatcher.repo_timeout", {
        tokenAddress: launch.tokenAddress,
        ageMs,
      });
      result.repoMisses += 1;
      return;
    }

    const discovery = await discoverRepoForAgent({
      tokenAddress: launch.tokenAddress,
      tokenName: launch.tokenName,
      tokenSymbol: launch.tokenSymbol,
    });

    if (discovery.repo === null) {
      // Stay pending — the next tick will retry until the 24h budget expires.
      return;
    }

    repoFullName = discovery.repo;
    method = discovery.method;
    await db
      .update(factoryLaunches)
      .set({
        repoFullName,
        repoDiscoveryMethod: method,
        repoDiscoveredAt: new Date(),
      })
      .where(eq(factoryLaunches.tokenAddress, launch.tokenAddress));
    result.reposDiscovered += 1;

    await writeFactoryRepoFoundDraft({
      tokenAddress: launch.tokenAddress,
      tokenSymbol: launch.tokenSymbol,
      tokenName: launch.tokenName,
      repoFullName,
    });
  }

  // Move to benchmarking + queue the roast. Use a status-gated UPDATE so two
  // dispatcher ticks racing on the same row only one wins.
  const submissionId = nanoid();
  const moved = await db
    .update(factoryLaunches)
    .set({
      prelaunchStatus: "benchmarking",
      prelaunchFindingId: submissionId,
    })
    .where(
      sql`${factoryLaunches.tokenAddress} = ${launch.tokenAddress} AND ${factoryLaunches.prelaunchStatus} = 'pending'`,
    )
    .returning({ tokenAddress: factoryLaunches.tokenAddress });

  if (moved.length === 0) {
    return; // race lost — another tick already moved it.
  }

  const repoUrl = `https://github.com/${repoFullName}`;
  await db.insert(roastSubmissions).values({
    id: submissionId,
    repoUrl,
    repoFullName,
    submitterEmail: null,
    submitterHandle: null,
    // ip_hash is required by schema. Factory-watcher rows aren't subject to
    // per-IP rate limits, but they still need a stable identifier. Use the
    // tokenAddress (already lowercase) to deduplicate replays for the same
    // launch across dispatcher ticks.
    ipHash: `factory:${launch.tokenAddress}`,
    status: "awaiting_approval" satisfies RoastSubmissionStatus,
    source: "factory_watcher",
  });
  result.dispatched += 1;

  logInfo("prelaunch_dispatcher.queued", {
    tokenAddress: launch.tokenAddress,
    submissionId,
    repoFullName,
  });
}

async function processBenchmarking(result: PrelaunchTickResult): Promise<void> {
  const benchmarking = await db
    .select()
    .from(factoryLaunches)
    .where(eq(factoryLaunches.prelaunchStatus, "benchmarking"));

  for (const launch of benchmarking) {
    try {
      await checkOneBenchmarking(launch, result);
    } catch (err) {
      logError("prelaunch_dispatcher.publish_check_failed", {
        tokenAddress: launch.tokenAddress,
        message: messageOf(err),
      });
    }
  }
}

async function checkOneBenchmarking(
  launch: FactoryLaunch,
  result: PrelaunchTickResult,
): Promise<void> {
  const submissionId = launch.prelaunchFindingId;
  if (submissionId === null) {
    // Inconsistent state — benchmarking without a linked roast. Log and skip;
    // operator will need to intervene from Sprint 4 portal.
    logWarn("prelaunch_dispatcher.benchmarking_without_submission", {
      tokenAddress: launch.tokenAddress,
    });
    return;
  }

  const submissions = await db
    .select({
      id: roastSubmissions.id,
      status: roastSubmissions.status,
      receiptId: roastSubmissions.receiptId,
    })
    .from(roastSubmissions)
    .where(eq(roastSubmissions.id, submissionId))
    .limit(1);
  const submission = submissions[0];

  if (submission === undefined) {
    logWarn("prelaunch_dispatcher.missing_submission", {
      tokenAddress: launch.tokenAddress,
      submissionId,
    });
    return;
  }

  if (submission.status === "published") {
    await db
      .update(factoryLaunches)
      .set({ prelaunchStatus: "published" })
      .where(eq(factoryLaunches.tokenAddress, launch.tokenAddress));
    result.publishedDetected += 1;

    await writeFactoryVerdictDraft({
      tokenAddress: launch.tokenAddress,
      tokenSymbol: launch.tokenSymbol,
      tokenName: launch.tokenName,
      findingsCount: 0,
      topSeverity: null,
      pageUrl: `${PUBLIC_BASE_URL}/agents/${launch.tokenAddress}`,
    });
    logInfo("prelaunch_dispatcher.published", {
      tokenAddress: launch.tokenAddress,
      submissionId,
      receiptId: submission.receiptId,
    });
    return;
  }

  if (submission.status === "rejected" || submission.status === "failed") {
    await db
      .update(factoryLaunches)
      .set({ prelaunchStatus: "benchmark_failed" })
      .where(eq(factoryLaunches.tokenAddress, launch.tokenAddress));
    logWarn("prelaunch_dispatcher.benchmark_failed", {
      tokenAddress: launch.tokenAddress,
      submissionId,
      submissionStatus: submission.status,
    });
  }
}

async function transitionStatus(
  tokenAddress: string,
  fromStatus: string,
  toStatus: string,
): Promise<void> {
  await db
    .update(factoryLaunches)
    .set({ prelaunchStatus: toStatus })
    .where(
      sql`${factoryLaunches.tokenAddress} = ${tokenAddress} AND ${factoryLaunches.prelaunchStatus} = ${fromStatus}`,
    );
}

// Suppress unused-import warning for `lt` and `isNull` — kept so future
// dispatcher logic (Sprint 4 operator portal) can use them without re-importing.
void lt;
void isNull;
