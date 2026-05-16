import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./exec.js";
import { FleetError } from "./errors.js";
import {
  FixPlanOutput,
  ReviewOutput,
  RevalidateOutput,
  fixPlanOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
} from "./types.js";
import { AgreementMode } from "./providers/agreement.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { openaiProvider } from "./providers/openai.js";
import { stackedProvider } from "./providers/stacked.js";
// openrouter + codex providers are deferred to v2; see ARCHITECTURE.md §Provider roster.
// Their source remains in tree and importable (tests are skipped); they are not
// registered in providerByName so they cannot be picked accidentally from config.

export type Provider = {
  name: string;
  check(root: string): Promise<string>;
  review(root: string, prompt: string, model: string | null): Promise<ReviewOutput>;
  fix(root: string, prompt: string, model: string | null): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, model: string | null): Promise<RevalidateOutput>;
};

export function providerByName(name: string): Provider {
  if (name === "mock") {
    return mockProvider;
  }
  if (name === "mock-fail") {
    return mockFailProvider;
  }
  if (name === "anthropic") {
    return anthropicProvider;
  }
  if (name === "openai") {
    return openaiProvider;
  }
  if (name === "stacked") {
    return buildStackedFromEnv();
  }
  throw new FleetError(`unsupported provider: ${name}`, 2, "unsupported-provider");
}

function buildStackedFromEnv(): Provider {
  const raw = process.env["FLEET_STACKED_PROVIDERS"] ?? "anthropic,openai";
  const childNames = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (childNames.length === 0) {
    throw new FleetError(
      "FLEET_STACKED_PROVIDERS must list at least one provider",
      2,
      "invalid-config",
    );
  }
  const agreementRaw = process.env["FLEET_STACKED_AGREEMENT"] ?? "unanimous";
  if (!isAgreementMode(agreementRaw)) {
    throw new FleetError(
      `FLEET_STACKED_AGREEMENT must be unanimous|majority|any (got: ${agreementRaw})`,
      2,
      "invalid-config",
    );
  }
  const children = childNames.map((n) => {
    if (n === "stacked") {
      throw new FleetError(
        "stacked provider cannot nest stacked as a child",
        2,
        "invalid-config",
      );
    }
    return providerByName(n);
  });
  return stackedProvider({ providers: children, agreement: agreementRaw });
}

function isAgreementMode(value: string): value is AgreementMode {
  return value === "unanimous" || value === "majority" || value === "any";
}

/**
 * Deferred-to-v2 providers. Their source stays in the tree so re-enabling them
 * is a single-line change in providerByName above; this accessor is the only
 * supported way to reach them today and is intentionally absent from the
 * factory so they cannot be selected via config or env. See
 * ARCHITECTURE.md §Provider roster for the rationale.
 */
export function deferredV2Providers(): Record<string, Provider> {
  return { codex: codexProvider };
}

const codexProvider: Provider = {
  name: "codex",
  async check(root: string): Promise<string> {
    const result = await runCommand("codex --version", root);
    if (result.exitCode !== 0) {
      throw new FleetError("codex CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async review(root: string, prompt: string, model: string | null): Promise<ReviewOutput> {
    const output = await runCodexJson(root, prompt, model, reviewJsonSchema);
    return reviewOutputSchema.parse(output);
  },
  async fix(root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    const output = await runCodexJson(root, prompt, model, fixPlanJsonSchema, "workspace-write");
    return fixPlanOutputSchema.parse(output);
  },
  async revalidate(root: string, prompt: string, model: string | null): Promise<RevalidateOutput> {
    const output = await runCodexJson(root, prompt, model, revalidateJsonSchema);
    return revalidateOutputSchema.parse(output);
  },
};

const mockProvider: Provider = {
  name: "mock",
  async check(): Promise<string> {
    return "mock";
  },
  async review(_root: string, prompt: string): Promise<ReviewOutput> {
    if (!prompt.includes("TODO_BUG") && !prompt.includes("BUG:")) {
      return { findings: [], inspected: { files: [], symbols: [], notes: ["mock clean"] } };
    }
    return {
      findings: [
        {
          title: "Marker bug found",
          category: "bug",
          severity: "medium",
          confidence: "high",
          evidence: [
            {
              path: "src/index.ts",
              startLine: null,
              endLine: null,
              symbol: null,
              quote: "TODO_BUG",
            },
          ],
          reasoning: "Mock provider found an explicit bug marker.",
          reproduction: null,
          recommendation: "Replace marker with real handling.",
          whyTestsDoNotAlreadyCoverThis:
            "Mock fixtures do not encode this marker as intended behavior.",
          suggestedRegressionTest: "Add a focused test that fails when TODO_BUG is present.",
          minimumFixScope: "Replace the marker in the owning feature file.",
        },
      ],
      inspected: { files: ["src/index.ts"], symbols: [], notes: ["mock finding"] },
    };
  },
  async fix(): Promise<FixPlanOutput> {
    return {
      summary: "mock fix plan",
      findingIds: [],
      plannedFiles: [],
      risk: "low",
      steps: ["mock"],
      validationCommands: ["touch SHOULD_NOT_RUN_PROVIDER_COMMANDS"],
    };
  },
  async revalidate(_root: string, prompt: string): Promise<RevalidateOutput> {
    if (prompt.includes("REVALIDATE_FIXED")) {
      return { outcome: "fixed", reasoning: "mock fixed outcome", commands: ["mock fixed"] };
    }
    if (prompt.includes("REVALIDATE_OPEN")) {
      return { outcome: "open", reasoning: "mock open outcome", commands: ["mock open"] };
    }
    if (prompt.includes("REVALIDATE_FALSE_POSITIVE")) {
      return {
        outcome: "false-positive",
        reasoning: "mock false-positive outcome",
        commands: ["mock false-positive"],
      };
    }
    return { outcome: "uncertain", reasoning: "mock provider cannot inspect fixes", commands: [] };
  },
};

const mockFailProvider: Provider = {
  name: "mock-fail",
  async check(): Promise<string> {
    return "mock-fail";
  },
  async review(): Promise<ReviewOutput> {
    throw new FleetError("mock review failure", 1, "mock-failure");
  },
  async fix(): Promise<FixPlanOutput> {
    throw new FleetError("mock fix failure", 1, "mock-failure");
  },
  async revalidate(): Promise<RevalidateOutput> {
    throw new FleetError("mock revalidate failure", 1, "mock-failure");
  },
};

async function runCodexJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  sandbox = "read-only",
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "fleet-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "output.json");
  await writeFile(schemaPath, JSON.stringify(schema), "utf8");
  const modelArg = model === null ? "" : ` --model ${shellQuote(model)}`;
  const command = `codex exec --cd ${shellQuote(root)} --sandbox ${sandbox} --output-schema ${shellQuote(schemaPath)} --output-last-message ${shellQuote(outputPath)}${modelArg} -`;
  const result = await runCommand(command, root, prompt);
  if (result.exitCode !== 0) {
    throw new FleetError(
      `codex provider failed: ${result.stderr || result.stdout}`,
      providerExitCode(result.stderr),
      "provider-failure",
    );
  }
  const raw = await readFile(outputPath, "utf8").catch(() => "");
  if (raw.trim().length === 0) {
    throw new FleetError("codex provider produced no JSON output", 8, "malformed-output");
  }
  return JSON.parse(raw) as unknown;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function providerExitCode(stderr: string): number {
  if (/auth|login|api key/iu.test(stderr)) {
    return 4;
  }
  if (/quota|rate.?limit/iu.test(stderr)) {
    return 5;
  }
  return 1;
}

export const reviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "inspected"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "title",
          "category",
          "severity",
          "confidence",
          "evidence",
          "reasoning",
          "reproduction",
          "recommendation",
          "whyTestsDoNotAlreadyCoverThis",
          "suggestedRegressionTest",
          "minimumFixScope",
        ],
        properties: {
          title: { type: "string" },
          category: {
            enum: [
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
            ],
          },
          severity: { enum: ["critical", "high", "medium", "low"] },
          confidence: { enum: ["high", "medium", "low"] },
          evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
          reasoning: { type: "string" },
          reproduction: { anyOf: [{ type: "string" }, { type: "null" }] },
          recommendation: { type: "string" },
          whyTestsDoNotAlreadyCoverThis: { type: "string" },
          suggestedRegressionTest: { anyOf: [{ type: "string" }, { type: "null" }] },
          minimumFixScope: { type: "string" },
        },
      },
    },
    inspected: {
      type: "object",
      additionalProperties: false,
      required: ["files", "symbols", "notes"],
      properties: {
        files: { type: "array", items: { type: "string" } },
        symbols: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
      },
    },
  },
  $defs: {
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["path", "startLine", "endLine", "symbol", "quote"],
      properties: {
        path: { type: "string" },
        startLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
        endLine: { anyOf: [{ type: "integer" }, { type: "null" }] },
        symbol: { anyOf: [{ type: "string" }, { type: "null" }] },
        quote: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
  },
};

export const revalidateJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "reasoning", "commands"],
  properties: {
    outcome: { enum: ["fixed", "open", "false-positive", "uncertain"] },
    reasoning: { type: "string" },
    commands: { type: "array", items: { type: "string" } },
  },
};

export const fixPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findingIds", "plannedFiles", "risk", "steps", "validationCommands"],
  properties: {
    summary: { type: "string" },
    findingIds: { type: "array", items: { type: "string" } },
    plannedFiles: { type: "array", items: { type: "string" } },
    risk: { enum: ["low", "medium", "high"] },
    steps: { type: "array", items: { type: "string" } },
    validationCommands: { type: "array", items: { type: "string" } },
  },
};
