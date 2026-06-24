import type { SarifSeverity } from "./sarif-types";

export type ExportableFinding = {
  findingId: string;
  title: string;
  severity: string;
  category: string;
  status: string;
  closureSha: string | null;
  patchAcceptedSha: string | null;
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  evidenceBundle: {
    affectedSha: string;
    pocSnippet: unknown;
    reproductionCommand: unknown;
    callPathTrace: unknown;
    bundleStatus: string;
  } | null;
};

export type SarifLog = {
  $schema: string;
  version: "2.1.0";
  runs: unknown[];
};

export function findingsToSarif(args: {
  owner: string;
  repo: string;
  findings: ExportableFinding[];
  baseUrl?: string;
}): SarifLog {
  const baseUrl = args.baseUrl ?? "https://www.antfleet.dev";
  const rules = new Map<string, unknown>();
  const results = args.findings.map((finding) => {
    const ruleId = ruleIdFor(finding);
    if (!rules.has(ruleId)) {
      rules.set(ruleId, {
        id: ruleId,
        name: finding.category,
        shortDescription: { text: finding.category },
        helpUri: `${baseUrl}/receipts/${finding.findingId}`,
        defaultConfiguration: { level: levelFor(finding.severity) },
        properties: {
          precision: "high",
          tags: ["security", `antfleet/${finding.category.toLowerCase()}`],
        },
      });
    }
    return {
      ruleId,
      level: levelFor(finding.severity),
      message: { text: finding.title },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: artifactFromEvidence(finding) },
            region: { startLine: lineFromEvidence(finding) ?? 1 },
          },
        },
      ],
      partialFingerprints: {
        antfleetFindingId: finding.findingId,
      },
      properties: {
        antfleetFindingId: finding.findingId,
        antfleetSeverity: normalizeSeverity(finding.severity),
        antfleetStatus: finding.status,
        antfleetReviewId: finding.reviewId,
        antfleetPrNumber: finding.prNumber,
        antfleetCommitSha: finding.commitSha,
        closureSha: finding.closureSha,
        patchAcceptedSha: finding.patchAcceptedSha,
        receiptUrl: `${baseUrl}/receipts/${finding.findingId}`,
        evidenceBundle: evidenceProperties(finding.evidenceBundle),
      },
    };
  });

  return {
    $schema:
      "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "AntFleet",
            semanticVersion: "0.1.0",
            informationUri: baseUrl,
            rules: [...rules.values()],
          },
        },
        automationDetails: {
          id: `antfleet/${args.owner}/${args.repo}`,
        },
        results,
      },
    ],
  };
}

export function validateSarifForGithub(log: SarifLog): string[] {
  const errors: string[] = [];
  if (log.version !== "2.1.0") errors.push("version must be 2.1.0");
  if (!Array.isArray(log.runs) || log.runs.length === 0) errors.push("runs must be non-empty");
  for (const [runIndex, run] of log.runs.entries()) {
    if (!isRecord(run)) {
      errors.push(`runs[${runIndex}] must be an object`);
      continue;
    }
    const driver = asRecord(asRecord(run["tool"])?.["driver"]);
    if (driver === null || typeof driver["name"] !== "string") {
      errors.push(`runs[${runIndex}].tool.driver.name is required`);
    }
    const results = Array.isArray(run["results"]) ? run["results"] : [];
    for (const [resultIndex, result] of results.entries()) {
      const record = asRecord(result);
      if (record === null) {
        errors.push(`runs[${runIndex}].results[${resultIndex}] must be an object`);
        continue;
      }
      if (typeof record["ruleId"] !== "string" || record["ruleId"].length === 0) {
        errors.push(`runs[${runIndex}].results[${resultIndex}].ruleId is required`);
      }
      if (messageText(record["message"]) === null) {
        errors.push(`runs[${runIndex}].results[${resultIndex}].message.text is required`);
      }
    }
  }
  return errors;
}

function ruleIdFor(finding: ExportableFinding): string {
  return `antfleet/${finding.category.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function levelFor(severity: string): "error" | "warning" | "note" {
  const normalized = normalizeSeverity(severity);
  if (normalized === "critical" || normalized === "high") return "error";
  if (normalized === "medium") return "warning";
  return "note";
}

function normalizeSeverity(severity: string): SarifSeverity {
  const value = severity.toLowerCase();
  if (value.includes("critical")) return "critical";
  if (value.includes("high")) return "high";
  if (value.includes("med")) return "medium";
  if (value.includes("low")) return "low";
  return "info";
}

function evidenceProperties(bundle: ExportableFinding["evidenceBundle"]): Record<string, unknown> {
  if (bundle === null) return {};
  return {
    bundleStatus: bundle.bundleStatus,
    affectedSha: bundle.affectedSha,
    poc: bundle.pocSnippet,
    reproCommand: bundle.reproductionCommand,
    reachabilityTrace: bundle.callPathTrace,
  };
}

function artifactFromEvidence(finding: ExportableFinding): string {
  const maybePath =
    pathFromSlot(finding.evidenceBundle?.pocSnippet) ??
    pathFromSlot(finding.evidenceBundle?.callPathTrace);
  return maybePath ?? `${finding.owner}/${finding.repo}`;
}

function lineFromEvidence(finding: ExportableFinding): number | null {
  return (
    lineFromSlot(finding.evidenceBundle?.pocSnippet) ??
    lineFromSlot(finding.evidenceBundle?.callPathTrace)
  );
}

function pathFromSlot(value: unknown): string | null {
  const slot = asRecord(value);
  const inner = asRecord(slot?.["value"]);
  return text(inner?.["path"]) ?? text(inner?.["artifactUri"]);
}

function lineFromSlot(value: unknown): number | null {
  const slot = asRecord(value);
  const inner = asRecord(slot?.["value"]);
  const line = inner?.["line"] ?? inner?.["startLine"];
  return typeof line === "number" && Number.isFinite(line) ? line : null;
}

function messageText(value: unknown): string | null {
  const record = asRecord(value);
  return text(record?.["text"]) ?? text(record?.["markdown"]);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
