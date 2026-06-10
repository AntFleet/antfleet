import { db } from "@/db";
import {
  claimAcpJobBudgetSetting,
  createAcpReviewJob,
  findAcpJobByAcpJobId,
  markAcpJobBudgetFailed,
  markAcpJobBudgetReconciliationRequired,
  markAcpJobBudgetSet,
  markAcpJobFundedAndQueued,
  type CreateReviewJobResult,
  type ReviewJobRow,
} from "@/lib/review-job-queries";
import { makePublicOctokit } from "@/lib/github-files-public";
import { isPublicRepo } from "@/lib/repo-visibility";
import { getAcpReviewPriceUsdc } from "@/lib/paywall/env";
import { logInfo, messageOf } from "@/lib/log";
import { processReviewJob } from "@/lib/review-job-worker";
import { checkAcpRepoCooldown, checkAcpWalletRateLimit } from "./rate-limit";
import { setAcpJobBudget, type AcpProviderCliOptions, type AcpCliResponse } from "./provider-cli";
import {
  normalizeAcpTargetRepo,
  parseAcpReviewRequest,
  validateTradingAcknowledgment,
  type AcpReviewRequest,
} from "./review-contract";

type Queryable = Parameters<typeof createAcpReviewJob>[0];
type PublicOctokit = ReturnType<typeof makePublicOctokit>;
type AcpResolvedTarget = { owner: string; repo: string; prNumber: number; sha: string };

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
        readStringPath(value, ["clientAgentWallet"]) ??
        readStringPath(value, ["client_agent_wallet"]) ??
        readStringPath(value, ["client", "agent_wallet"]) ??
        readStringPath(value, ["client", "wallet"]) ??
        readStringPath(value, ["job", "client_agent_wallet"]) ??
        readStringPath(value, ["job", "client", "agent_wallet"]),
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
    markAcpFundedAndQueued?: typeof markAcpJobFundedAndQueued;
    processJob?: typeof processReviewJob;
    setBudget?: typeof setAcpJobBudget;
    findExistingJob?: typeof findAcpJobByAcpJobId;
    checkWalletRateLimit?: typeof checkAcpWalletRateLimit;
    checkRepoCooldown?: typeof checkAcpRepoCooldown;
    claimBudgetSetting?: typeof claimAcpJobBudgetSetting;
    markBudgetSet?: typeof markAcpJobBudgetSet;
    markBudgetFailed?: typeof markAcpJobBudgetFailed;
    markBudgetReconciliationRequired?: typeof markAcpJobBudgetReconciliationRequired;
    validateTarget?: typeof validateAcpReviewTarget;
    q?: Queryable;
    cliOptions?: AcpProviderCliOptions;
  } = {},
): Promise<AcpCreatedJobOutcome | AcpFundedJobOutcome | { ignored: string }> {
  const event = parseAcpProviderEvent(value);
  const q = deps.q ?? db;
  if (event.kind === "ignored") return { ignored: event.reason };
  if (event.kind === "job_created") {
    return createBudgetedAcpReviewJob(event, {
      createJob: deps.createJob,
      setBudget: deps.setBudget,
      findExistingJob: deps.findExistingJob,
      checkWalletRateLimit: deps.checkWalletRateLimit,
      checkRepoCooldown: deps.checkRepoCooldown,
      claimBudgetSetting: deps.claimBudgetSetting,
      markBudgetSet: deps.markBudgetSet,
      markBudgetFailed: deps.markBudgetFailed,
      markBudgetReconciliationRequired: deps.markBudgetReconciliationRequired,
      validateTarget: deps.validateTarget,
      q,
      cliOptions: deps.cliOptions,
    });
  }
  return runFundedAcpReviewJob(event.acpJobId, {
    findJob: deps.findJob ?? findAcpJobByAcpJobId,
    markAcpFundedAndQueued: deps.markAcpFundedAndQueued ?? markAcpJobFundedAndQueued,
    processJob: deps.processJob ?? processReviewJob,
    q,
  });
}

export async function createBudgetedAcpReviewJob(
  event: Extract<AcpProviderEvent, { kind: "job_created" }>,
  deps: {
    createJob?: typeof createAcpReviewJob;
    setBudget?: typeof setAcpJobBudget;
    findExistingJob?: typeof findAcpJobByAcpJobId;
    checkWalletRateLimit?: typeof checkAcpWalletRateLimit;
    checkRepoCooldown?: typeof checkAcpRepoCooldown;
    claimBudgetSetting?: typeof claimAcpJobBudgetSetting;
    markBudgetSet?: typeof markAcpJobBudgetSet;
    markBudgetFailed?: typeof markAcpJobBudgetFailed;
    markBudgetReconciliationRequired?: typeof markAcpJobBudgetReconciliationRequired;
    validateTarget?: typeof validateAcpReviewTarget;
    q?: Queryable;
    cliOptions?: AcpProviderCliOptions;
  } = {},
): Promise<AcpCreatedJobOutcome> {
  const q = deps.q ?? db;
  const createJob = deps.createJob ?? createAcpReviewJob;
  const clientAgentWallet = requireAcpClientWallet(event.clientAgentWallet);
  const target = await (deps.validateTarget ?? validateAcpReviewTarget)(event.request);
  const targetKey = acpTargetIdempotencyKey(clientAgentWallet, target);
  if (shouldRunPreCreateAcpAbuseChecks(deps)) {
    const existingJob = await (deps.findExistingJob ?? findAcpJobByAcpJobId)(q, event.acpJobId);
    if (existingJob === null) {
      await assertAcpWalletAndRepoAllowed({
        q,
        clientAgentWallet,
        target,
        checkWalletRateLimit: deps.checkWalletRateLimit ?? checkAcpWalletRateLimit,
        checkRepoCooldown: deps.checkRepoCooldown ?? checkAcpRepoCooldown,
      });
    }
  }
  const result: CreateReviewJobResult = await createJob(q, {
    acpJobId: event.acpJobId,
    clientAgentWallet,
    repoOwner: target.owner,
    repoName: target.repo,
    prNumber: target.prNumber,
    sha: target.sha,
    requestPayload: event.request,
    targetKey,
    idempotencyKey: `acp:${event.acpJobId}`,
    initialStatus: "billing_pending",
  });
  assertAcpDuplicateTargetPolicy(event.acpJobId, result.row);
  let budget: AcpCliResponse | null = null;
  if (shouldSetAcpBudget(result.row)) {
    const budgetClaimed = await (deps.claimBudgetSetting ?? claimAcpJobBudgetSetting)(
      q,
      result.row.jobId,
      new Date(),
    );
    if (!budgetClaimed) {
      if (result.row.acpBudgetStatus === "setting") {
        throw Object.assign(new Error("ACP budget setup requires operator reconciliation"), {
          failureModeTag: "provider_error",
        });
      }
      logInfo("acp.job_created_budget_claim_skipped", {
        acpJobId: event.acpJobId,
        antfleetJobId: result.row.jobId,
      });
      return { job: result.row, created: result.created, budget: null };
    }
    try {
      budget = await (deps.setBudget ?? setAcpJobBudget)({
        acpJobId: event.acpJobId,
        amountUsdc: getAcpReviewPriceUsdc(),
        options: deps.cliOptions,
      });
    } catch (err) {
      try {
        await (deps.markBudgetFailed ?? markAcpJobBudgetFailed)(
          q,
          result.row.jobId,
          {
            message: messageOf(err),
          },
          new Date(),
        );
      } catch (markErr) {
        logInfo("acp.job_created_budget_mark_failed_failed", {
          acpJobId: event.acpJobId,
          antfleetJobId: result.row.jobId,
          message: messageOf(markErr),
        });
      }
      throw err;
    }

    try {
      await (deps.markBudgetSet ?? markAcpJobBudgetSet)(
        q,
        result.row.jobId,
        budget.json ?? budget.stdout,
        new Date(),
      );
    } catch (err) {
      try {
        await (deps.markBudgetReconciliationRequired ?? markAcpJobBudgetReconciliationRequired)(
          q,
          result.row.jobId,
          {
            message:
              "ACP budget was set externally but local persistence failed; operator reconciliation required",
            budget: budget.json ?? budget.stdout,
            persistenceError: messageOf(err),
          },
          new Date(),
        );
      } catch (markErr) {
        logInfo("acp.job_created_budget_mark_reconcile_failed", {
          acpJobId: event.acpJobId,
          antfleetJobId: result.row.jobId,
          message: messageOf(markErr),
        });
      }
      logInfo("acp.job_created_budget_mark_set_failed", {
        acpJobId: event.acpJobId,
        antfleetJobId: result.row.jobId,
        message: messageOf(err),
      });
      throw err;
    }
  }
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
    markAcpFundedAndQueued?: typeof markAcpJobFundedAndQueued;
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
      ? await (deps.markAcpFundedAndQueued ?? markAcpJobFundedAndQueued)(q, job.jobId)
      : false;
  if (job.status === "billing_pending" && !queued) {
    throw Object.assign(new Error("ACP funded job is not ready to queue"), {
      failureModeTag: "provider_error",
    });
  }
  const worker =
    job.status === "complete" || job.status === "failed"
      ? null
      : await (deps.processJob ?? processReviewJob)(job.jobId);
  if (worker?.kind === "skipped") {
    throw Object.assign(new Error(`ACP review job worker skipped: ${worker.reason}`), {
      failureModeTag: "provider_error",
    });
  }
  logInfo("acp.job_funded", { acpJobId, antfleetJobId: job.jobId, queued });
  return { job, queued, worker };
}

export async function validateAcpReviewTarget(
  request: AcpReviewRequest,
  octokit: PublicOctokit = makePublicOctokit(),
): Promise<AcpResolvedTarget> {
  const target = normalizeAcpTargetRepo(request.target.repo);
  const publicRepo = await isPublicRepo(
    octokit as Parameters<typeof isPublicRepo>[0],
    target.owner,
    target.repo,
  );
  if (!publicRepo) {
    throw Object.assign(new Error("ACP target repository is not publicly accessible"), {
      failureModeTag: "repo_not_accessible",
    });
  }

  if (request.target.pr !== undefined) {
    try {
      const pr = await octokit.rest.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: request.target.pr,
      });
      if (pr.data.state !== "open") {
        throw Object.assign(new Error(`PR #${request.target.pr} is ${pr.data.state}`), {
          failureModeTag: "pr_not_open",
        });
      }
      await assertAcpTradingAcknowledgment({
        request,
        target,
        prNumber: request.target.pr,
        sha: pr.data.head.sha,
        octokit,
      });
      return { ...target, prNumber: request.target.pr, sha: pr.data.head.sha };
    } catch (err) {
      if ((err as { failureModeTag?: string }).failureModeTag) throw err;
      const status = (err as { status?: number })?.status;
      const mode = status === 403 || status === 404 ? "repo_not_accessible" : "provider_error";
      throw Object.assign(new Error(`Failed to resolve ACP PR target: ${messageOf(err)}`), {
        failureModeTag: mode,
      });
    }
  }

  if (request.target.sha === undefined) {
    throw Object.assign(new Error("ACP job requires target.pr or target.sha"), {
      failureModeTag: "invalid_input",
    });
  }

  const matches: Array<{ prNumber: number; sha: string }> = [];
  try {
    const pulls = await octokit.paginate(octokit.rest.pulls.list, {
      owner: target.owner,
      repo: target.repo,
      state: "open",
      per_page: 100,
    });
    for (const pr of pulls) {
      if (pr.head.sha.toLowerCase().startsWith(request.target.sha.toLowerCase())) {
        matches.push({ prNumber: pr.number, sha: pr.head.sha });
      }
    }
  } catch (err) {
    throw Object.assign(new Error(`Failed to resolve ACP SHA target: ${messageOf(err)}`), {
      failureModeTag: "repo_not_accessible",
    });
  }
  if (matches.length === 0) {
    throw Object.assign(new Error("ACP SHA target is not the head of an open PR"), {
      failureModeTag: "sha_not_in_open_pr",
    });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error("ACP SHA target matches multiple open PRs"), {
      failureModeTag: "sha_ambiguous",
    });
  }
  const match = matches[0] as { prNumber: number; sha: string };
  await assertAcpTradingAcknowledgment({
    request,
    target,
    prNumber: match.prNumber,
    sha: match.sha,
    octokit,
  });
  return { ...target, prNumber: match.prNumber, sha: match.sha };
}

function shouldSetAcpBudget(job: ReviewJobRow): boolean {
  return (
    job.status === "billing_pending" &&
    job.acpBudgetStatus !== "set" &&
    job.acpBudgetStatus !== "set_reconcile"
  );
}

function requireAcpClientWallet(value: string | null): string {
  if (value === null || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw Object.assign(new Error("ACP client wallet missing from authenticated event metadata"), {
      failureModeTag: "invalid_input",
    });
  }
  return value.toLowerCase();
}

function shouldRunPreCreateAcpAbuseChecks(deps: {
  createJob?: typeof createAcpReviewJob;
  findExistingJob?: typeof findAcpJobByAcpJobId;
  checkWalletRateLimit?: typeof checkAcpWalletRateLimit;
  checkRepoCooldown?: typeof checkAcpRepoCooldown;
}): boolean {
  return (
    deps.createJob === undefined ||
    deps.findExistingJob !== undefined ||
    deps.checkWalletRateLimit !== undefined ||
    deps.checkRepoCooldown !== undefined
  );
}

async function assertAcpWalletAndRepoAllowed(args: {
  q: Queryable;
  clientAgentWallet: string;
  target: AcpResolvedTarget;
  checkWalletRateLimit: typeof checkAcpWalletRateLimit;
  checkRepoCooldown: typeof checkAcpRepoCooldown;
}): Promise<void> {
  const now = new Date();
  const walletLimit = await args.checkWalletRateLimit(args.q, {
    clientWallet: args.clientAgentWallet,
    now,
  });
  if (!walletLimit.ok) {
    throw Object.assign(
      new Error(`ACP wallet rate limit exceeded; retry after ${walletLimit.retryAfterSeconds}s`),
      { failureModeTag: "rate_limited", retryAfterSeconds: walletLimit.retryAfterSeconds },
    );
  }
  const repoCooldown = await args.checkRepoCooldown(args.q, {
    owner: args.target.owner,
    repo: args.target.repo,
    now,
  });
  if (!repoCooldown.ok) {
    throw Object.assign(
      new Error(`ACP repo cooldown active; retry after ${repoCooldown.retryAfterSeconds}s`),
      { failureModeTag: "rate_limited", retryAfterSeconds: repoCooldown.retryAfterSeconds },
    );
  }
}

function assertAcpDuplicateTargetPolicy(incomingAcpJobId: string, row: ReviewJobRow): void {
  if (row.acpJobId === null || row.acpJobId === undefined) return;
  if (row.acpJobId === incomingAcpJobId) return;
  throw Object.assign(
    new Error(
      "ACP duplicate target already accepted for this wallet/repo/PR/SHA; create a fresh target after cooldown or wait for the existing ACP job",
    ),
    {
      failureModeTag: "invalid_input",
      existingAcpJobId: row.acpJobId ?? null,
      incomingAcpJobId,
    },
  );
}

function acpTargetIdempotencyKey(wallet: string, target: AcpResolvedTarget): string {
  return `acp-target:${wallet}:${target.owner.toLowerCase()}/${target.repo.toLowerCase()}:${
    target.prNumber
  }:${target.sha.toLowerCase()}`;
}

async function assertAcpTradingAcknowledgment(args: {
  request: AcpReviewRequest;
  target: ReturnType<typeof normalizeAcpTargetRepo>;
  prNumber: number;
  sha: string;
  octokit: PublicOctokit;
}): Promise<void> {
  const [repoMetadata, changedFilePaths] = await Promise.all([
    readAcpRepoMetadata(args.octokit, args.target.owner, args.target.repo),
    readAcpPrChangedFilePaths({
      octokit: args.octokit,
      owner: args.target.owner,
      repo: args.target.repo,
      prNumber: args.prNumber,
    }),
  ]);
  const acknowledged = validateTradingAcknowledgment({
    request: args.request,
    repoName: repoMetadata.repoName ?? args.target.repo,
    repoDescription: repoMetadata.repoDescription,
    repoTopics: repoMetadata.repoTopics,
    changedFilePaths,
  });
  if (!acknowledged) {
    throw Object.assign(
      new Error(
        "ACP trading-code request requires options.acknowledge_not_financial_advice=true",
      ),
      { failureModeTag: "invalid_input" },
    );
  }
}

async function readAcpRepoMetadata(
  octokit: PublicOctokit,
  owner: string,
  repo: string,
): Promise<{
  repoName: string | null;
  repoDescription: string | null;
  repoTopics: string[];
}> {
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return {
      repoName: typeof data.name === "string" ? data.name : repo,
      repoDescription: typeof data.description === "string" ? data.description : null,
      repoTopics: Array.isArray(data.topics)
        ? data.topics.filter((topic): topic is string => typeof topic === "string")
        : [],
    };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const mode = status === 403 || status === 404 ? "repo_not_accessible" : "provider_error";
    throw Object.assign(new Error(`Failed to read ACP repo metadata: ${messageOf(err)}`), {
      failureModeTag: mode,
    });
  }
}

async function readAcpPrChangedFilePaths(args: {
  octokit: PublicOctokit;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<string[]> {
  try {
    const files = await args.octokit.paginate(args.octokit.rest.pulls.listFiles, {
      owner: args.owner,
      repo: args.repo,
      pull_number: args.prNumber,
      per_page: 100,
    });
    return files
      .map((file) => (typeof file.filename === "string" ? file.filename : null))
      .filter((filename): filename is string => filename !== null);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const mode = status === 403 || status === 404 ? "repo_not_accessible" : "provider_error";
    throw Object.assign(new Error(`Failed to read ACP PR files: ${messageOf(err)}`), {
      failureModeTag: mode,
    });
  }
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
