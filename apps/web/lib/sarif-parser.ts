import { createHash } from "node:crypto";
import {
  MAX_SARIF_BYTES,
  MAX_SARIF_FINDINGS_PER_BATCH,
  MAX_SARIF_PATH_BYTES,
  MAX_SARIF_RESULTS_PER_RUN,
  MAX_SARIF_RUNS,
  MAX_SARIF_TEXT_FIELD_BYTES,
  SarifLimitError,
  type NormalizedSarifFinding,
  type SarifParseResult,
  type SarifSeverity,
} from "./sarif-types";

type JsonRecord = Record<string, unknown>;

export function parseSarif(input: string | JsonRecord): SarifParseResult {
  if (typeof input === "string" && Buffer.byteLength(input, "utf8") > MAX_SARIF_BYTES) {
    throw new SarifLimitError("MAX_SARIF_BYTES", `SARIF JSON exceeds ${MAX_SARIF_BYTES} bytes`);
  }
  const root = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!isRecord(root)) throw new Error("SARIF root must be an object");
  if (root["version"] !== "2.1.0") throw new Error("only SARIF version 2.1.0 is supported");
  const runs = asArray(root["runs"]);
  if (runs.length === 0) throw new Error("SARIF must contain at least one run");
  if (runs.length > MAX_SARIF_RUNS) {
    throw new SarifLimitError("MAX_SARIF_RUNS", `runs.length must be <= ${MAX_SARIF_RUNS}`);
  }

  const findings: NormalizedSarifFinding[] = [];
  let firstToolName = "unknown";
  let sourceRevision: string | null = null;

  runs.forEach((runValue, runIndex) => {
    if (!isRecord(runValue)) return;
    const driver = getDriver(runValue);
    const toolName = text(driver["name"]) ?? "unknown";
    if (runIndex === 0) firstToolName = toolName;
    sourceRevision ??= revisionFromRun(runValue);
    const sourceTool = detectTool(toolName, runValue);
    const rules = rulesById(driver);
    const results = asArray(runValue["results"]);
    if (results.length > MAX_SARIF_RESULTS_PER_RUN) {
      throw new SarifLimitError(
        "MAX_SARIF_RESULTS_PER_RUN",
        `run ${runIndex} results.length must be <= ${MAX_SARIF_RESULTS_PER_RUN}`,
      );
    }

    results.forEach((resultValue, resultIndex) => {
      if (!isRecord(resultValue)) return;
      if (findings.length >= MAX_SARIF_FINDINGS_PER_BATCH) {
        throw new SarifLimitError(
          "MAX_SARIF_FINDINGS_PER_BATCH",
          `total findings must be <= ${MAX_SARIF_FINDINGS_PER_BATCH}`,
        );
      }
      enforceResultFieldCaps(resultValue);
      const ruleId = text(resultValue["ruleId"]) ?? text(resultValue["rule"]) ?? "unknown-rule";
      const rule = rules.get(ruleId) ?? {};
      const location = firstPhysicalLocation(resultValue);
      const artifactUri = checkedText(
        "MAX_SARIF_PATH_BYTES",
        location?.artifactUri ?? "unknown",
        MAX_SARIF_PATH_BYTES,
      );
      const message = checkedText(
        "MAX_SARIF_TEXT_FIELD_BYTES",
        messageText(resultValue["message"]) ?? ruleMessage(rule) ?? ruleId,
        MAX_SARIF_TEXT_FIELD_BYTES,
      );
      const level =
        text(resultValue["level"]) ??
        text(asRecord(rule["defaultConfiguration"])?.["level"]) ??
        "warning";
      const dialectProperties = collectDialectProperties(resultValue, rule);
      const normalized: Omit<NormalizedSarifFinding, "externalFingerprint"> = {
        sourceTool,
        sourceToolName: toolName,
        ruleId,
        ruleName: text(rule["name"]) ?? text(rule["shortDescription"]) ?? null,
        level,
        severity: severityFrom(resultValue, rule, level),
        message,
        artifactUri,
        startLine: location?.startLine ?? null,
        endLine: location?.endLine ?? location?.startLine ?? null,
        regionSnippet:
          location?.snippet === undefined || location.snippet === null
            ? null
            : checkedText(
                "MAX_SARIF_TEXT_FIELD_BYTES",
                location.snippet,
                MAX_SARIF_TEXT_FIELD_BYTES,
              ),
        helpUri: text(resultValue["helpUri"]) ?? text(rule["helpUri"]) ?? null,
        cwe: cweFrom(rule, resultValue),
        tags: tagsFrom(rule, resultValue),
        dialectProperties,
        originalClaim: resultValue,
      };
      findings.push({
        ...normalized,
        externalFingerprint: fingerprintFor(runIndex, resultIndex, normalized),
      });
    });
  });

  return {
    sourceTool: findings[0]?.sourceTool ?? detectTool(firstToolName, {}),
    sourceToolName: firstToolName,
    sourceRevision,
    findings,
  };
}

function getDriver(run: JsonRecord): JsonRecord {
  const tool = asRecord(run["tool"]);
  const driver = asRecord(tool?.["driver"]);
  if (driver === null) throw new Error("SARIF run.tool.driver is required");
  return driver;
}

function rulesById(driver: JsonRecord): Map<string, JsonRecord> {
  const out = new Map<string, JsonRecord>();
  for (const value of asArray(driver["rules"])) {
    if (!isRecord(value)) continue;
    const id = text(value["id"]);
    if (id !== null) out.set(id, value);
  }
  return out;
}

function firstPhysicalLocation(result: JsonRecord): {
  artifactUri: string;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
} | null {
  const locations = asArray(result["locations"]);
  for (const location of locations) {
    const physical = asRecord(asRecord(location)?.["physicalLocation"]);
    const artifact = asRecord(physical?.["artifactLocation"]);
    const uri = text(artifact?.["uri"]);
    if (uri === null) continue;
    const region = asRecord(physical?.["region"]);
    const snippet = messageText(asRecord(region?.["snippet"]) ?? null);
    return {
      artifactUri: uri,
      startLine: numberOrNull(region?.["startLine"]),
      endLine: numberOrNull(region?.["endLine"]),
      snippet,
    };
  }
  return null;
}

function enforceResultFieldCaps(result: JsonRecord): void {
  const message = messageText(result["message"]);
  if (message !== null) {
    checkedText("MAX_SARIF_TEXT_FIELD_BYTES", message, MAX_SARIF_TEXT_FIELD_BYTES);
  }
  for (const location of asArray(result["locations"])) {
    const physical = asRecord(asRecord(location)?.["physicalLocation"]);
    const artifact = asRecord(physical?.["artifactLocation"]);
    const uri = text(artifact?.["uri"]);
    if (uri !== null) {
      checkedText("MAX_SARIF_PATH_BYTES", uri, MAX_SARIF_PATH_BYTES);
    }
    const snippet = messageText(asRecord(asRecord(physical?.["region"])?.["snippet"]) ?? null);
    if (snippet !== null) {
      checkedText("MAX_SARIF_TEXT_FIELD_BYTES", snippet, MAX_SARIF_TEXT_FIELD_BYTES);
    }
  }
}

function detectTool(toolName: string, run: JsonRecord): NormalizedSarifFinding["sourceTool"] {
  const lower = toolName.toLowerCase();
  if (lower.includes("codeql")) return "codeql";
  if (lower.includes("snyk")) return "snyk";
  if (lower.includes("semgrep")) return "semgrep";
  const automationId = text(asRecord(run["automationDetails"])?.["id"])?.toLowerCase() ?? "";
  if (automationId.includes("codeql")) return "codeql";
  if (automationId.includes("snyk")) return "snyk";
  if (automationId.includes("semgrep")) return "semgrep";
  return "unknown";
}

function severityFrom(result: JsonRecord, rule: JsonRecord, level: string): SarifSeverity {
  const props = [asRecord(result["properties"]), asRecord(rule["properties"])];
  for (const p of props) {
    const raw =
      text(p?.["security-severity"]) ?? text(p?.["severity"]) ?? text(p?.["problem.severity"]);
    const mapped = mapSeverity(raw);
    if (mapped !== null) return mapped;
  }
  return mapSeverity(level) ?? "medium";
}

function mapSeverity(raw: string | null): SarifSeverity | null {
  if (raw === null) return null;
  const v = raw.toLowerCase();
  const numeric = Number(v);
  if (!Number.isNaN(numeric)) {
    if (numeric >= 9) return "critical";
    if (numeric >= 7) return "high";
    if (numeric >= 4) return "medium";
    if (numeric > 0) return "low";
  }
  if (v.includes("critical") || v === "error") return "critical";
  if (v.includes("high")) return "high";
  if (v.includes("medium") || v === "warning") return "medium";
  if (v.includes("low") || v === "note") return "low";
  if (v.includes("info") || v.includes("recommendation")) return "info";
  return null;
}

function collectDialectProperties(result: JsonRecord, rule: JsonRecord): Record<string, unknown> {
  return {
    result: asRecord(result["properties"]) ?? {},
    rule: asRecord(rule["properties"]) ?? {},
    partialFingerprints: asRecord(result["partialFingerprints"]) ?? {},
    fingerprints: asRecord(result["fingerprints"]) ?? {},
  };
}

function cweFrom(rule: JsonRecord, result: JsonRecord): string[] {
  return tagsFrom(rule, result)
    .map((tag) => tag.match(/cwe[-_](\d+)/i)?.[1])
    .filter((v): v is string => v !== undefined)
    .map((id) => `CWE-${id}`);
}

function tagsFrom(rule: JsonRecord, result: JsonRecord): string[] {
  const values = [
    ...asStringArray(asRecord(rule["properties"])?.["tags"]),
    ...asStringArray(asRecord(result["properties"])?.["tags"]),
  ];
  return [...new Set(values)];
}

function revisionFromRun(run: JsonRecord): string | null {
  const invocations = asArray(run["invocations"]);
  for (const invocation of invocations) {
    const rev = text(asRecord(invocation)?.["revisionId"]);
    if (rev !== null) return rev;
  }
  return text(asRecord(run["versionControlProvenance"])?.["revisionId"]);
}

function fingerprintFor(
  runIndex: number,
  resultIndex: number,
  finding: Omit<NormalizedSarifFinding, "externalFingerprint">,
): string {
  const stable = [
    runIndex,
    resultIndex,
    finding.sourceToolName,
    finding.ruleId,
    finding.artifactUri,
    finding.startLine ?? "",
    finding.message,
  ].join("\0");
  return createHash("sha256").update(stable).digest("hex");
}

function ruleMessage(rule: JsonRecord): string | null {
  return messageText(rule["fullDescription"]) ?? messageText(rule["shortDescription"]);
}

function messageText(value: unknown): string | null {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return text(record?.["text"]) ?? text(record?.["markdown"]);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function checkedText(limitName: string, value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new SarifLimitError(limitName, `field must be <= ${maxBytes} bytes`);
  }
  return value;
}
