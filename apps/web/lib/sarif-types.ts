export type SarifSeverity = "critical" | "high" | "medium" | "low" | "info";

export const MAX_SARIF_BYTES = 10 * 1024 * 1024;
export const MAX_SARIF_RUNS = 50;
export const MAX_SARIF_RESULTS_PER_RUN = 5000;
export const MAX_SARIF_FINDINGS_PER_BATCH = 20000;
export const MAX_SARIF_TEXT_FIELD_BYTES = 32 * 1024;
export const MAX_SARIF_PATH_BYTES = 4 * 1024;

export class SarifLimitError extends Error {
  readonly status = 413;

  constructor(limitName: string, detail: string) {
    super(`${limitName} exceeded: ${detail}`);
    this.name = "SarifLimitError";
  }
}

export type NormalizedSarifFinding = {
  externalFingerprint: string;
  sourceTool: "codeql" | "snyk" | "semgrep" | "unknown";
  sourceToolName: string;
  ruleId: string;
  ruleName: string | null;
  level: string;
  severity: SarifSeverity;
  message: string;
  artifactUri: string;
  startLine: number | null;
  endLine: number | null;
  regionSnippet: string | null;
  helpUri: string | null;
  cwe: string[];
  tags: string[];
  dialectProperties: Record<string, unknown>;
  originalClaim: Record<string, unknown>;
};

export type SarifParseResult = {
  sourceTool: NormalizedSarifFinding["sourceTool"];
  sourceToolName: string;
  sourceRevision: string | null;
  findings: NormalizedSarifFinding[];
};

export type SarifValidationVerdict =
  | "pending"
  | "false_positive"
  | "real"
  | "inconclusive"
  | "error";

export type SarifBatchStats = {
  totalClaims: number;
  realCount: number;
  falsePositiveCount: number;
  inconclusiveCount: number;
  errorCount: number;
};
