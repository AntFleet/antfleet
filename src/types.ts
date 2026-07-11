import { z } from "zod";

export const findingCategories = [
  "bug",
  "security",
  "performance",
  "concurrency",
  "api-contract",
  "data-loss",
  "test-gap",
  "docs-gap",
  "build-release",
  "maintainability",
] as const;

export const findingLabels = ["blocking", "nit", "optional", "fyi"] as const;
export type FindingLabel = (typeof findingLabels)[number];

export const findingTriages = [
  "confirmed-bug",
  "contract-mismatch",
  "risk",
  "test-gap",
  "docs-gap",
] as const;

export function deriveFindingTriage(
  category: (typeof findingCategories)[number],
  confidence: "high" | "medium" | "low",
): (typeof findingTriages)[number] {
  if (category === "test-gap") {
    return "test-gap";
  }
  if (category === "docs-gap") {
    return "docs-gap";
  }
  if (category === "api-contract") {
    return "contract-mismatch";
  }
  if (confidence === "high" && ["bug", "security", "data-loss", "concurrency"].includes(category)) {
    return "confirmed-bug";
  }
  return "risk";
}

export const featureKinds = [
  "cli-command",
  "route",
  "ui-flow",
  "service",
  "job",
  "agent-tool",
  "library",
  "config",
  "release",
  "test-suite",
  "infra",
  "unknown",
] as const;

export const featureStatuses = [
  "pending",
  "claimed",
  "reviewed",
  "needs-fix",
  "fixing",
  "fixed",
  "revalidated",
  "skipped",
  "error",
] as const;

export const trustBoundaries = [
  "user-input",
  "network",
  "filesystem",
  "secrets",
  "process-exec",
  "database",
  "auth",
  "permissions",
  "concurrency",
  "external-api",
  "serialization",
] as const;

export const projectCommandsSchema = z.object({
  typecheck: z.string().nullable(),
  lint: z.string().nullable(),
  format: z.string().nullable(),
  test: z.string().nullable(),
});

export type ProjectCommands = z.infer<typeof projectCommandsSchema>;

export const projectRecordSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  name: z.string(),
  rootPath: z.string(),
  git: z.object({
    remoteUrl: z.string().nullable(),
    defaultBranch: z.string().nullable(),
    currentBranch: z.string().nullable(),
    headSha: z.string().nullable(),
  }),
  detected: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    packageManagers: z.array(z.string()),
    commands: projectCommandsSchema,
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  stateDir: z.string(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  provider: z.object({
    name: z.string(),
    model: z.string().nullable(),
  }),
  commands: projectCommandsSchema,
  review: z.object({
    maxContextFiles: z.number().int().positive(),
    maxOwnedFiles: z.number().int().positive(),
    maxFindingsPerFeature: z.number().int().positive(),
    minConfidenceToFix: z.enum(["high", "medium", "low"]),
  }),
  git: z.object({
    requireCleanWorktreeForFix: z.boolean(),
    commit: z.boolean(),
    openPr: z.boolean(),
  }),
});

export type FleetConfig = z.infer<typeof configSchema>;

export const featureFileRefSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const featureEntrypointSchema = z.object({
  path: z.string(),
  symbol: z.string().nullable(),
  route: z.string().nullable(),
  command: z.string().nullable(),
});

export const featureTestRefSchema = z.object({
  path: z.string(),
  command: z.string().nullable(),
});

export const analysisEntrySchema = z.object({
  runId: z.string(),
  kind: z.string(),
  summary: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.string(),
});

export const featureLockSchema = z.object({
  lockedByRunId: z.string(),
  lockedAt: z.string(),
  hostname: z.string(),
  pid: z.number().int(),
});

export const featureRecordSchema = z.object({
  schemaVersion: z.literal(1),
  featureId: z.string(),
  title: z.string(),
  summary: z.string(),
  kind: z.enum(featureKinds),
  source: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  entrypoints: z.array(featureEntrypointSchema),
  ownedFiles: z.array(featureFileRefSchema),
  contextFiles: z.array(featureFileRefSchema),
  tests: z.array(featureTestRefSchema),
  tags: z.array(z.string()),
  trustBoundaries: z.array(z.enum(trustBoundaries)),
  status: z.enum(featureStatuses),
  lock: featureLockSchema.nullable(),
  findingIds: z.array(z.string()),
  patchAttemptIds: z.array(z.string()),
  analysisHistory: z.array(analysisEntrySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type FeatureRecord = z.infer<typeof featureRecordSchema>;
export type FeatureKind = FeatureRecord["kind"];
export type TrustBoundary = FeatureRecord["trustBoundaries"][number];

// Nullable evidence fields default to null so a MISSING key parses as null
// rather than throwing. Opus 4.7 intermittently OMITS these keys entirely
// (e.g. `quote`) instead of sending null; Zod's `.nullable()` accepts null but
// not `undefined`, so a single omitted key used to fail the whole
// reviewOutputSchema.parse — which, under the 2-of-2 unanimous gate, discarded
// the entire review and every other (valid) finding. That was the AntSeed
// "0 findings on re-run" bug (#134): 4 of the dogfood re-runs degraded to zero
// on exactly `findings[i].evidence[j].quote: undefined`. `.default(null)`
// keeps the OUTPUT type `string | null` (the matcher and Finding type are
// unchanged) while tolerating the omitted key. `path` stays required — it is
// the load-bearing anchor; a missing path makes the evidence entry unusable.
export const evidenceRefSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().nullable().default(null),
  endLine: z.number().int().positive().nullable().default(null),
  symbol: z.string().nullable().default(null),
  quote: z.string().nullable().default(null),
});

export const findingHistoryEntrySchema = z.object({
  runId: z.string().nullable(),
  kind: z.string(),
  status: z.enum(["open", "false-positive", "fixed", "wont-fix", "uncertain"]).nullable(),
  note: z.string().nullable(),
  reasoning: z.string().nullable(),
  commands: z.array(z.string()),
  createdAt: z.string(),
});

export type FindingHistoryEntry = z.infer<typeof findingHistoryEntrySchema>;

export const findingRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    findingId: z.string(),
    featureId: z.string(),
    title: z.string(),
    category: z.enum(findingCategories),
    severity: z.enum(["critical", "high", "medium", "low"]),
    label: z.enum(["blocking", "nit", "optional", "fyi"]).default("blocking"),
    confidence: z.enum(["high", "medium", "low"]),
    triage: z.enum(findingTriages).optional(),
    evidence: z.array(evidenceRefSchema),
    reasoning: z.string(),
    reproduction: z.string().nullable(),
    recommendation: z.string(),
    whyTestsDoNotAlreadyCoverThis: z.string().optional(),
    suggestedRegressionTest: z.string().nullable().optional(),
    minimumFixScope: z.string().optional(),
    status: z.enum(["open", "false-positive", "fixed", "wont-fix", "uncertain"]),
    history: z.array(findingHistoryEntrySchema).optional(),
    signature: z.string(),
    linkedPatchAttemptIds: z.array(z.string()),
    createdByRunId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .transform((finding) => ({
    ...finding,
    triage: finding.triage ?? deriveFindingTriage(finding.category, finding.confidence),
    whyTestsDoNotAlreadyCoverThis: finding.whyTestsDoNotAlreadyCoverThis ?? "",
    suggestedRegressionTest: finding.suggestedRegressionTest ?? null,
    minimumFixScope: finding.minimumFixScope ?? "",
    history: finding.history ?? [],
  }));

export type FindingRecord = z.infer<typeof findingRecordSchema>;

export const commandResultSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export type CommandResult = z.infer<typeof commandResultSchema>;

export const patchAttemptSchema = z.object({
  schemaVersion: z.literal(1),
  patchAttemptId: z.string(),
  findingIds: z.array(z.string()),
  featureIds: z.array(z.string()),
  status: z.enum(["planned", "applying", "applied", "validated", "failed", "abandoned"]),
  plan: z.string(),
  filesChanged: z.array(z.string()),
  commandsRun: z.array(commandResultSchema),
  testResults: z.array(commandResultSchema),
  provider: z
    .object({
      name: z.string(),
      model: z.string().nullable(),
      requestId: z.string().nullable(),
      startedAt: z.string(),
      finishedAt: z.string(),
    })
    .nullable(),
  git: z.object({
    baseSha: z.string().nullable(),
    commitSha: z.string().nullable(),
    branchName: z.string().nullable(),
    prUrl: z.string().nullable(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PatchAttempt = z.infer<typeof patchAttemptSchema>;

export const runRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  rootPath: z.string(),
  headSha: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  claimedFeatureIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  patchAttemptIds: z.array(z.string()),
  errors: z.array(
    z.object({
      message: z.string(),
      code: z.string().nullable(),
    }),
  ),
});

export type RunRecord = z.infer<typeof runRecordSchema>;

export const reviewOutputSchema = z.object({
  findings: z.array(
    z
      .object({
        title: z.string(),
        // Off-enum category falls back to "bug" rather than throwing. Opus 4.7
        // intermittently emits a category outside `findingCategories` (a #134
        // dogfood run failed on `invalid_value` here). Nuking the whole review
        // over one mislabeled finding is far worse than reclassifying it: a
        // survived finding at worst fails to cluster with the other model's
        // (different) category and lands as a single-model disagreement — it is
        // not silently lost. Severity is a separate field, so the policy-review
        // cap below is unaffected.
        category: z.enum(findingCategories).catch("bug"),
        severity: z.enum(["critical", "high", "medium", "low"]),
        label: z.enum(findingLabels).default("blocking"),
        confidence: z.enum(["high", "medium", "low"]),
        evidence: z.array(evidenceRefSchema),
        reasoning: z.string(),
        // Same omitted-key tolerance as evidence fields (#134): a missing
        // `reproduction`/`suggestedRegressionTest` key defaults to null instead
        // of failing the parse. Output type stays `string | null`.
        reproduction: z.string().nullable().default(null),
        recommendation: z.string(),
        whyTestsDoNotAlreadyCoverThis: z.string(),
        suggestedRegressionTest: z.string().nullable().default(null),
        minimumFixScope: z.string(),
        // Set when severity hinges on whether the flagged behavior is intentional
        // design (a documented limit, a granted escape hatch) rather than a bug.
        // Signals the model could not tell a bug from a feature, so the finding
        // must not enter the two-model gate as a blocking critical/high defect —
        // the severity cap below ENFORCES that in code (the prompt also asks the
        // model to cap, but we don't rely on model compliance). Optional + default
        // false keeps pre-flag stored findings parsing unchanged.
        requiresPolicyReview: z.boolean().optional().default(false),
        // Set when a finding's root cause lives in an external dependency (npm
        // package, imported contract, upstream SDK) rather than the reviewed
        // files — the fix path is an upstream PR. Null when the bug is in the
        // reviewed code. Optional + default null keeps existing findings valid.
        // Currently collected for analysis only: it rides along in the
        // agreement_decision JSONB but no consumer reads it yet (the live
        // upstream-PR workflow is operator-seeded via outgoing_prs). When a
        // consumer is built, note that the agreement gate's pickRepresentative
        // keeps ONE clustered finding and discards the other model's
        // package/reason — a merge policy will be needed at that point.
        upstreamOrigin: z
          .object({ package: z.string(), reason: z.string() })
          .nullable()
          .optional()
          .default(null),
      })
      // Enforce the policy-review severity cap at the single parse chokepoint
      // every provider shares (anthropic.ts / openai.ts / provider.ts each call
      // reviewOutputSchema.parse). A model that flags requiresPolicyReview but
      // forgets to lower severity would otherwise post a false critical/high
      // through the blocking gate — exactly the false positive the flag exists
      // to prevent. Clamp is symmetric across providers, so it does not perturb
      // the gate's deterministic clustering. Output shape (and the Finding type)
      // is unchanged: severity stays the same enum.
      .transform((finding) => ({
        ...finding,
        severity:
          finding.requiresPolicyReview &&
          (finding.severity === "critical" || finding.severity === "high")
            ? ("medium" as const)
            : finding.severity,
      })),
  ),
  inspected: z.object({
    files: z.array(z.string()),
    symbols: z.array(z.string()),
    notes: z.array(z.string()),
  }),
});

export type ReviewOutput = z.infer<typeof reviewOutputSchema>;

export const revalidateOutputSchema = z.object({
  outcome: z.enum(["fixed", "open", "false-positive", "uncertain"]),
  reasoning: z.string(),
  commands: z.array(z.string()),
});

export type RevalidateOutput = z.infer<typeof revalidateOutputSchema>;

export const fixPlanOutputSchema = z.object({
  summary: z.string(),
  findingIds: z.array(z.string()),
  plannedFiles: z.array(z.string()),
  risk: z.enum(["low", "medium", "high"]),
  steps: z.array(z.string()),
  validationCommands: z.array(z.string()),
});

export type FixPlanOutput = z.infer<typeof fixPlanOutputSchema>;

// Patch Agent v1.5 — per-finding suggestion payload. Returned by each
// provider's `proposePatch` call, one call per agreed finding. `patch` is
// null when the model declines to propose a fix (e.g. the finding is a
// design issue rather than a localized bug, or the fix would exceed the
// 20-line cap). `rationale` is debug-only and never user-visible; the
// rendered suggestion block in pr-comment.ts shows only the patch body.
export const patchSuggestionOutputSchema = z.object({
  patch: z.string().nullable(),
  rationale: z.string().nullable(),
});

export type PatchSuggestionOutput = z.infer<typeof patchSuggestionOutputSchema>;

// Token spend for a single provider call. Captured from the SDK response's
// usage block (Anthropic: input_tokens/output_tokens; OpenAI:
// prompt_tokens/completion_tokens) and threaded out so the patch lane can
// price the call. Null when the provider response omits usage (older SDKs
// or a streaming path that doesn't aggregate). Observability-only — never
// gates drawdown.
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

// Provider-returned per-call payload that carries the resolved model id
// alongside the schema-validated content. The provider modules know the
// actual model used (default fallback when caller passes model: null);
// downstream callers shouldn't have to re-derive it. Used by the
// orchestrator + agreement gate to record the truthful patchModelId.
// `usage` carries the call's token spend for patch-cost accounting. Optional
// (and null-able): the real providers always populate it, but a mock or an
// older SDK path may omit it, in which case the cost layer reads it as
// "unknown" (priced at $0) rather than failing.
export type PatchSuggestionResult = PatchSuggestionOutput & {
  modelId: string;
  usage?: TokenUsage | null;
};
