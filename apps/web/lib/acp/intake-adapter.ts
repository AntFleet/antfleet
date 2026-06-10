import { db } from "@/db";
import {
  createAcpReviewJob,
  findAcpJobByAcpJobId,
  markJobQueued,
  type CreateReviewJobResult,
  type ReviewJobRow,
} from "@/lib/review-job-queries";
import { getReviewPriceUsdc } from "@/lib/paywall/env";
import { logInfo } from "@/lib/log";
import { processReviewJob } from "@/lib/review-job-worker";
import { setAcpJobBudget, type AcpProviderCliOptions, type AcpCliResponse } from "./provider-cli";
import {
  normalizeAcpTargetRepo,
  parseAcpReviewRequest,
  type AcpReviewRequest,
} from "./review-contract";

type Queryable = Parameters<typeof createAcpReviewJob>[0];

export type AcpProviderEvent =
  | {
      kind: "job_created";
      acpJobId: string;
      request: AcpReviewRequest;
      clientAgentWallet: string | null;
      raw: unknown;
    }
  | { kind: "job_funded"; acpJobId: string; raw: unknown }
  | { kind: "ignored"; reason: string; raw: unknown };

export type AcpCreatedJobOutcome = {
  job: ReviewJobRow;
  created: boolean;
  budget: AcpCliResponse | null;
};

export type AcpFundedJobOutcome = {
  job: ReviewJobRow;
  queued: boolean;
  worker: Awaited<ReturnType<typeof processReviewJob>> | null;
};

export function parseAcpProviderEvent(value: unknown): AcpProviderEvent {
  const type = readEventType(value);
  const acpJobId = readStringPath(value, ["jobId"]) ?? readStringPath(value, ["job_id"]);
  if (acpJobId === null) return { kind: "ignored", reason: "missing_job_id", raw: value };

  if (type === "job.created" || type === "job_created") {
    const rawRequirements =
      readPath(value, ["requirements"]) ??
      readPath(value, ["job", "requirements"]) ??
      readPath(value, ["payload", "requirements"]);
    const request = parseAcpReviewRequest(readJsonValue(rawRequirements));
    return {
      kind: "job_created",
      acpJobId,
      request,
      clientAgentWallet:
        request.client?.agent_wallet ??
        readStringPath(value, ["clientAgentWallet"]) ??
        readStringPath(value, ["client_agent_wallet"]) ??
        readStringPath(value, ["client", "agent_wallet"]),
      raw: value,
    };
  }

  if (type === "job.funded" || type === "job_funded" || type === "budget.funded") {
    return { kind: "job_funded", acpJobId, raw: value };
  }

  return { kind: "ignored", reason: `event_${type ?? "unknown"}`, raw: value };
}

export async function handleAcpProviderEvent(
  value: unknown,
  deps: {
    createJob?: typeof createAcpReviewJob;
    findJob?: typeof findAcpJobByAcpJobId;
    markQueued?: typeof markJobQueued;
    processJob?: typeof processReviewJob;
    setBudget?: typeof setAcpJobBudget;
    q?: Queryable;
    cliOptions?: AcpProviderCliOptions;
  } = {},
): Promise<AcpCreatedJobOutcome | AcpFundedJobOutcome | { ignored: string }> {
  const event = parseAcpProviderEvent(value);
  const q = deps.q ?? db;
  if (event.kind === "ignored") return { ignored: event.reason };
  if (event.kind === "job_created") {
    return createBudgetedAcpReviewJob(event, {
      createJob: deps.createJob ?? createAcpReviewJob,
      setBudget: deps.setBudget ?? setAcpJobBudget,
      q,
      cliOptions: deps.cliOptions,
    });
  }
  return runFundedAcpReviewJob(event.acpJobId, {
    findJob: deps.findJob ?? findAcpJobByAcpJobId,
    markQueued: deps.markQueued ?? markJobQueued,
    processJob: deps.processJob ?? processReviewJob,
    q,
  });
}

export async function createBudgetedAcpReviewJob(
  event: Extract<AcpProviderEvent, { kind: "job_created" }>,
  deps: {
    createJob?: typeof createAcpReviewJob;
    setBudget?: typeof setAcpJobBudget;
    q?: Queryable;
    cliOptions?: AcpProviderCliOptions;
  } = {},
): Promise<AcpCreatedJobOutcome> {
  const q = deps.q ?? db;
  const createJob = deps.createJob ?? createAcpReviewJob;
  const target = normalizeAcpTargetRepo(event.request.target.repo);
  const result: CreateReviewJobResult = await createJob(q, {
    acpJobId: event.acpJobId,
    clientAgentWallet: event.clientAgentWallet,
    repoOwner: target.owner,
    repoName: target.repo,
    prNumber: event.request.target.pr ?? null,
    sha: event.request.target.sha ?? null,
    requestPayload: event.request,
    idempotencyKey: `acp:${event.acpJobId}`,
    initialStatus: "billing_pending",
  });
  const budget = result.created
    ? await (deps.setBudget ?? setAcpJobBudget)({
        acpJobId: event.acpJobId,
        amountUsdc: getReviewPriceUsdc(),
        options: deps.cliOptions,
      })
    : null;
  logInfo("acp.job_created", {
    acpJobId: event.acpJobId,
    antfleetJobId: result.row.jobId,
    created: result.created,
  });
  return { job: result.row, created: result.created, budget };
}

export async function runFundedAcpReviewJob(
  acpJobId: string,
  deps: {
    findJob?: typeof findAcpJobByAcpJobId;
    markQueued?: typeof markJobQueued;
    processJob?: typeof processReviewJob;
    q?: Queryable;
  } = {},
): Promise<AcpFundedJobOutcome> {
  const q = deps.q ?? db;
  const job = await (deps.findJob ?? findAcpJobByAcpJobId)(q, acpJobId);
  if (job === null) {
    throw new Error(`ACP job ${acpJobId} has no AntFleet review_jobs row`);
  }
  const queued =
    job.status === "billing_pending"
      ? await (deps.markQueued ?? markJobQueued)(q, job.jobId)
      : false;
  const worker =
    job.status === "complete" || job.status === "failed"
      ? null
      : await (deps.processJob ?? processReviewJob)(job.jobId);
  logInfo("acp.job_funded", { acpJobId, antfleetJobId: job.jobId, queued });
  return { job, queued, worker };
}

function readEventType(value: unknown): string | null {
  return (
    readStringPath(value, ["type"]) ??
    readStringPath(value, ["event"]) ??
    readStringPath(value, ["eventType"]) ??
    readStringPath(value, ["event_type"])
  );
}

function readJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readStringPath(value: unknown, path: string[]): string | null {
  const found = readPath(value, path);
  return typeof found === "string" && found.trim().length > 0 ? found : null;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
