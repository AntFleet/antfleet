import type { DisclosureState } from "./disclosure-types";
import type { GhsaAdvisoryInput, GhsaSeverity } from "./ghsa-client";

export type AdvisoryFindingContext = {
  findingId: string;
  title: string;
  severity: string;
  category: string;
  reviewId: string;
  findingIndex: number;
  owner: string | null;
  repo: string | null;
  commitSha: string;
  prNumber: number;
  disclosureState: DisclosureState;
  agreementDecision: unknown;
  providerResponses: unknown;
  evidenceBundle: {
    affectedSha: string;
    pocSnippet: unknown;
    reproductionCommand: unknown;
    callPathTrace: unknown;
    bundleStatus: string;
  } | null;
  threatModel: unknown;
};

export function generateGhsaMarkdown(ctx: AdvisoryFindingContext): string {
  const repoName = repoFullName(ctx);
  const agreed = agreedFinding(ctx.agreementDecision, ctx.findingIndex);
  const evidence = evidenceLines(agreed);
  const reasoning = textField(agreed, "reasoning");
  const recommendation = textField(agreed, "recommendation");
  const lines = [
    `<!-- antfleet-finding-id:${ctx.findingId} -->`,
    "",
    `# ${ctx.title}`,
    "",
    "## Summary",
    `${ctx.severity.toUpperCase()} ${ctx.category} finding in ${repoName}.`,
    "",
    "## Impact",
    reasoning ??
      "Operator review required. The original finding did not include a separate impact paragraph.",
    "",
    "## Affected Versions",
    `Affected commit: \`${ctx.commitSha}\``,
    "",
    "## Patched Versions",
    "Pending maintainer fix.",
    "",
    "## Evidence",
    evidence.length > 0
      ? evidence.map((line) => `- ${line}`).join("\n")
      : "- No source evidence lines were available in the finding payload.",
    "",
    "## Validation Bundle",
    validationBundleBlock(ctx),
    "",
    "## Threat Model Context",
    threatModelBlock(ctx.threatModel),
    "",
    "## Recommended Remediation",
    recommendation ?? "Patch under maintainer review.",
    "",
    "## References",
    `- AntFleet review: \`${ctx.reviewId}\``,
    `- Source PR: ${repoName}#${ctx.prNumber}`,
    "",
    "## Credits",
    "Found by AntFleet and coordinated with the affected maintainers.",
    "",
  ];
  return lines.join("\n");
}

export function ghsaInputFromAdvisory(ctx: AdvisoryFindingContext): GhsaAdvisoryInput {
  const owner = ctx.owner ?? "unknown-owner";
  const repo = ctx.repo ?? "unknown-repo";
  return {
    owner,
    repo,
    summary: ctx.title.slice(0, 1024),
    description: generateGhsaMarkdown(ctx),
    idempotencyMarker: `antfleet-finding-id:${ctx.findingId}`,
    severity: normalizeGhsaSeverity(ctx.severity),
    affectedPackageName: `${owner}/${repo}`,
    vulnerableVersionRange: `<= ${ctx.commitSha.slice(0, 12)}`,
    patchedVersions: null,
  };
}

export function normalizeGhsaSeverity(severity: string): GhsaSeverity {
  const normalized = severity.trim().toLowerCase();
  if (normalized === "critical") return "critical";
  if (normalized === "high") return "high";
  if (normalized === "medium" || normalized === "med") return "medium";
  return "low";
}

function repoFullName(ctx: Pick<AdvisoryFindingContext, "owner" | "repo">): string {
  if (ctx.owner === null || ctx.repo === null) return "unknown repository";
  return `${ctx.owner}/${ctx.repo}`;
}

function agreedFinding(agreementDecision: unknown, index: number): Record<string, unknown> | null {
  if (typeof agreementDecision !== "object" || agreementDecision === null) return null;
  const agreed = (agreementDecision as Record<string, unknown>)["agreed"];
  if (!Array.isArray(agreed)) return null;
  const finding = agreed[index];
  return typeof finding === "object" && finding !== null
    ? (finding as Record<string, unknown>)
    : null;
}

function evidenceLines(finding: Record<string, unknown> | null): string[] {
  if (finding === null) return [];
  const evidence = finding["evidence"];
  if (!Array.isArray(evidence)) return [];
  return evidence.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const obj = item as Record<string, unknown>;
    const path = typeof obj["path"] === "string" ? obj["path"] : null;
    if (path === null) return [];
    const start = typeof obj["startLine"] === "number" ? obj["startLine"] : null;
    const end = typeof obj["endLine"] === "number" ? obj["endLine"] : start;
    if (start === null) return [path];
    return [`${path}:${start}${end !== null && end !== start ? `-${end}` : ""}`];
  });
}

function textField(finding: Record<string, unknown> | null, field: string): string | null {
  const value = finding?.[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function validationBundleBlock(ctx: AdvisoryFindingContext): string {
  const bundle = ctx.evidenceBundle;
  if (bundle === null) return "No evidence bundle row was available.";
  const sections = [
    `Bundle status: \`${bundle.bundleStatus}\``,
    `Affected SHA: \`${bundle.affectedSha}\``,
  ];
  if (bundle.pocSnippet !== null) sections.push(`PoC snippet: ${jsonSummary(bundle.pocSnippet)}`);
  if (bundle.reproductionCommand !== null) {
    sections.push(`Reproduction command: ${jsonSummary(bundle.reproductionCommand)}`);
  }
  if (bundle.callPathTrace !== null) {
    sections.push(`Call path trace: ${jsonSummary(bundle.callPathTrace)}`);
  }
  return sections.map((line) => `- ${line}`).join("\n");
}

function threatModelBlock(threatModel: unknown): string {
  if (threatModel === null || threatModel === undefined)
    return "No threat model row was available.";
  return jsonSummary(threatModel);
}

function jsonSummary(value: unknown): string {
  try {
    return `\`${JSON.stringify(value).slice(0, 700)}\``;
  } catch {
    return "`[unserializable]`";
  }
}
