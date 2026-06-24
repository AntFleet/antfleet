import {
  createSarifImportBatch,
  finishSarifImportBatch,
  hashRepo,
  insertSarifFindings,
  updateSarifFindingValidation,
  type CreateSarifImportBatchInput,
} from "@/db/queries";
import type { NewSarifFinding } from "@/db/schema";
import { isSarifIngestEnabledForInstall } from "./daybreak-gates-env";
import type { ChangedFile } from "./github-files";
import { runPatchAgent } from "./patch-agent";
import { applyReachabilityGate, type ApplyReachabilityResult } from "./reachability-gate";
import { applyPatchVerifier, realPatchVerifierIo, type PatchVerifyVerdict } from "./patch-verifier";
import { parseSarif } from "./sarif-parser";
import type { Finding } from "./review-types";
import {
  MAX_SARIF_FINDINGS_PER_BATCH,
  SarifLimitError,
  type NormalizedSarifFinding,
  type SarifBatchStats,
  type SarifParseResult,
  type SarifValidationVerdict,
} from "./sarif-types";

export type ConfirmationVerdict = "real" | "false_positive" | "inconclusive";

export type SarifConfirmationResult = {
  verdict: ConfirmationVerdict;
  reason: string;
  modelIds: string[];
};

export type SarifIngestInput = {
  owner: string;
  repo: string;
  installationId: number | null;
  sarifText: string;
  sourceKind: "upload" | "url" | "code_scanning";
  sourceUrl?: string | null;
  fileBlobRef?: string | null;
  repoUrl?: string | null;
  sha?: string | null;
};

export type SarifIngestDeps = {
  createBatch: typeof createSarifImportBatch;
  insertFindings: typeof insertSarifFindings;
  updateFinding: typeof updateSarifFindingValidation;
  finishBatch: typeof finishSarifImportBatch;
  confirmation?: (claim: NormalizedSarifFinding) => Promise<SarifConfirmationResult>;
  reachability: (args: {
    claim: NormalizedSarifFinding;
    finding: Finding;
    changedFile: ChangedFile;
  }) => Promise<ApplyReachabilityResult>;
  patchAndVerify?: (args: {
    claim: NormalizedSarifFinding;
    finding: Finding;
    changedFile: ChangedFile;
    installationId: number | null;
    owner: string;
    repo: string;
    repoUrl: string | null;
    sha: string | null;
  }) => Promise<PatchVerifyVerdict | null>;
  enabled: (installationId: number | null, repo: string) => Promise<boolean>;
};

const DEFAULT_DEPS: SarifIngestDeps = {
  createBatch: createSarifImportBatch,
  insertFindings: insertSarifFindings,
  updateFinding: updateSarifFindingValidation,
  finishBatch: finishSarifImportBatch,
  reachability: async ({ finding, changedFile }) =>
    applyReachabilityGate({
      agreed: [finding],
      owner: "unknown",
      repo: "unknown",
      files: [changedFile],
    }),
  patchAndVerify: defaultPatchAndVerify,
  enabled: isSarifIngestEnabledForInstall,
};

export async function ingestSarif(
  input: SarifIngestInput,
  deps: SarifIngestDeps = DEFAULT_DEPS,
): Promise<{ batchId: string; stats: SarifBatchStats; parsed: SarifParseResult }> {
  if (!(await deps.enabled(input.installationId, input.repo))) {
    throw new Error("ANTFLEET_SARIF_INGEST is disabled");
  }

  const parsed = parseSarif(input.sarifText);
  if (parsed.findings.length > MAX_SARIF_FINDINGS_PER_BATCH) {
    throw new SarifLimitError(
      "MAX_SARIF_FINDINGS_PER_BATCH",
      `worker batch must be <= ${MAX_SARIF_FINDINGS_PER_BATCH} findings`,
    );
  }
  const batchInput: CreateSarifImportBatchInput = {
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    repoHash: hashRepo(input.owner, input.repo),
    sourceTool: parsed.sourceToolName,
    sourceKind: input.sourceKind,
    sourceRevision: parsed.sourceRevision,
    sourceUrl: input.sourceUrl ?? null,
    fileBlobRef: input.fileBlobRef ?? null,
    totalClaims: parsed.findings.length,
  };
  const batchId = await deps.createBatch(batchInput);
  await deps.insertFindings(parsed.findings.map((claim) => toDbFinding(batchId, claim)));

  const stats: SarifBatchStats = {
    totalClaims: parsed.findings.length,
    realCount: 0,
    falsePositiveCount: 0,
    inconclusiveCount: 0,
    errorCount: 0,
  };

  for (const claim of parsed.findings) {
    const finding = claimToFinding(claim);
    const changedFile = claimToChangedFile(claim);
    let verdict: SarifValidationVerdict = "inconclusive";
    let confirmationVerdict: string | null = null;
    let reachabilityVerdict: string | null = null;
    let patchVerifyVerdict: string | null = null;
    let closureReceipt: unknown = null;

    try {
      const confirmation = deps.confirmation ? await deps.confirmation(claim) : null;
      confirmationVerdict = confirmation?.verdict ?? null;
      if (confirmation?.verdict === "false_positive") {
        verdict = "false_positive";
        closureReceipt = closureReceiptFor(claim, "consensus-confirm false positive", confirmation);
      } else {
        const reachability = await deps.reachability({ claim, finding, changedFile });
        const firstRow = reachability.rows[0];
        reachabilityVerdict = firstRow?.outcome.verdict ?? "skipped";
        if (reachability.downgrades.length > 0 || reachabilityVerdict === "unreachable") {
          verdict = "false_positive";
          closureReceipt = closureReceiptFor(
            claim,
            "reachability gate unreachable",
            firstRow?.outcome,
          );
        } else if (reachabilityVerdict === "reachable") {
          try {
            patchVerifyVerdict =
              (await deps.patchAndVerify?.({
                claim,
                finding,
                changedFile,
                installationId: input.installationId,
                owner: input.owner,
                repo: input.repo,
                repoUrl: input.repoUrl ?? null,
                sha: input.sha ?? parsed.sourceRevision,
              })) ?? null;
          } catch {
            patchVerifyVerdict = null;
          }
          verdict = sarifVerdictFromPatchVerify(patchVerifyVerdict);
        } else {
          verdict = "inconclusive";
        }
      }
    } catch (err) {
      verdict = "error";
      closureReceipt = { error: err instanceof Error ? err.message : String(err) };
    }

    incrementStats(stats, verdict);
    await deps.updateFinding({
      batchId,
      externalFingerprint: claim.externalFingerprint,
      validationVerdict: verdict,
      confirmationVerdict,
      reachabilityVerdict,
      patchVerifyVerdict,
      closureReceipt,
      linkedFindingStatusId: null,
    });
  }

  await deps.finishBatch(batchId, {
    status: stats.errorCount > 0 ? "completed_with_errors" : "completed",
    realCount: stats.realCount,
    falsePositiveCount: stats.falsePositiveCount,
    inconclusiveCount: stats.inconclusiveCount,
    errorCount: stats.errorCount,
  });
  return { batchId, stats, parsed };
}

export async function defaultPatchAndVerify(args: {
  claim: NormalizedSarifFinding;
  finding: Finding;
  changedFile: ChangedFile;
  installationId: number | null;
  owner: string;
  repo: string;
  repoUrl: string | null;
  sha: string | null;
}): Promise<PatchVerifyVerdict | null> {
  if (args.installationId === null || args.sha === null) return null;
  const outcome = await runPatchAgent({
    reviewId: `sarif-${args.claim.externalFingerprint.slice(0, 32)}`,
    installationId: args.installationId,
    repo: args.repo,
    findings: [args.finding],
    changedFiles: [args.changedFile],
  });
  if (outcome === null || outcome.byIndex.size === 0) return null;
  const result = await applyPatchVerifier({
    outcome,
    repoUrl: args.repoUrl,
    sha: args.sha,
    findingAt: (index) => (index === 0 ? args.finding : undefined),
    findingIdAt: () => args.claim.externalFingerprint,
    io: realPatchVerifierIo(),
  });
  return result.rows[0]?.outcome.verdict ?? null;
}

function sarifVerdictFromPatchVerify(verdict: string | null | undefined): SarifValidationVerdict {
  return verdict === "verified" ? "real" : "inconclusive";
}

function toDbFinding(batchId: string, claim: NormalizedSarifFinding): NewSarifFinding {
  return {
    batchId,
    externalFingerprint: claim.externalFingerprint,
    sourceTool: claim.sourceToolName,
    ruleId: claim.ruleId,
    ruleName: claim.ruleName,
    level: claim.level,
    severity: claim.severity,
    message: claim.message,
    artifactUri: claim.artifactUri,
    startLine: claim.startLine,
    endLine: claim.endLine,
    originalClaim: claim.originalClaim,
    normalizedClaim: claim,
  };
}

export function claimToFinding(claim: NormalizedSarifFinding): Finding {
  return {
    title: claim.message,
    severity: claim.severity === "info" ? "low" : claim.severity,
    category: "security",
    label: "blocking",
    confidence: "medium",
    reasoning: `External scanner ${claim.sourceToolName} reported ${claim.ruleId}.`,
    evidence: [
      {
        path: claim.artifactUri,
        startLine: claim.startLine,
        endLine: claim.endLine,
        symbol: null,
        quote: claim.regionSnippet,
      },
    ],
    reproduction: null,
    recommendation: "Validate reachability and apply the scanner-specific remediation.",
    whyTestsDoNotAlreadyCoverThis:
      "Imported scanner backlog claim; no AntFleet regression test yet.",
    suggestedRegressionTest: null,
    minimumFixScope: "Patch the reported vulnerable code path only.",
    requiresPolicyReview: false,
    upstreamOrigin: null,
  };
}

function claimToChangedFile(claim: NormalizedSarifFinding): ChangedFile {
  return {
    filename: claim.artifactUri,
    contents: claim.regionSnippet ?? claim.message,
    status: "modified",
    sha: "sarif",
    patch: null,
  };
}

function closureReceiptFor(
  claim: NormalizedSarifFinding,
  reason: string,
  evidence: unknown,
): Record<string, unknown> {
  return {
    kind: "sarif_closure_receipt",
    sourceTool: claim.sourceToolName,
    ruleId: claim.ruleId,
    artifactUri: claim.artifactUri,
    startLine: claim.startLine,
    reason,
    evidence,
  };
}

function incrementStats(stats: SarifBatchStats, verdict: SarifValidationVerdict): void {
  if (verdict === "real") stats.realCount++;
  else if (verdict === "false_positive") stats.falsePositiveCount++;
  else if (verdict === "error") stats.errorCount++;
  else stats.inconclusiveCount++;
}
