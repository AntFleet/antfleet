export type SarifSeverity = "critical" | "high" | "medium" | "low" | "info";

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
