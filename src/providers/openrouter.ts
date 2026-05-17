import OpenAI from "openai";
import { FleetError, assertDefined } from "../errors.js";
import type { Provider } from "../provider.js";
import {
  fixPlanJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider.js";
import {
  FixPlanOutput,
  ReviewOutput,
  RevalidateOutput,
  fixPlanOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
} from "../types.js";

const DEFAULT_MODEL = "deepseek/deepseek-chat";
const DEFAULT_FALLBACK_MODEL = "qwen/qwen-2.5-coder-32b-instruct";
const BASE_URL = "https://openrouter.ai/api/v1";
const HTTP_REFERER = "https://www.antfleet.dev";
const X_TITLE = "AntFleet";

export const openrouterProvider: Provider = {
  name: "openrouter",
  async check(): Promise<string> {
    requireApiKey();
    return `openrouter ready (default: ${DEFAULT_MODEL}; fallback: ${fallbackModel()})`;
  },
  async review(_root: string, prompt: string, model: string | null): Promise<ReviewOutput> {
    const json = await callOpenRouter({
      prompt,
      model: model ?? DEFAULT_MODEL,
      schemaName: "fleet_review",
      schema: reviewJsonSchema,
    });
    return reviewOutputSchema.parse(json);
  },
  async fix(_root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    // Week 1: read-only. Plan only.
    const json = await callOpenRouter({
      prompt,
      model: model ?? DEFAULT_MODEL,
      schemaName: "fleet_fix_plan",
      schema: fixPlanJsonSchema,
    });
    return fixPlanOutputSchema.parse(json);
  },
  async revalidate(
    _root: string,
    prompt: string,
    model: string | null,
  ): Promise<RevalidateOutput> {
    const json = await callOpenRouter({
      prompt,
      model: model ?? DEFAULT_MODEL,
      schemaName: "fleet_revalidate",
      schema: revalidateJsonSchema,
    });
    return revalidateOutputSchema.parse(json);
  },
};

type CallOptions = {
  prompt: string;
  model: string;
  schemaName: string;
  schema: object;
};

/**
 * Calls OpenRouter with primary + fallback retry policy.
 *
 * Many OpenRouter-hosted models do not honor OpenAI strict `response_format`
 * `json_schema`, so we instead include the schema in the system prompt and ask
 * for JSON-object response. We tolerate up to 2 malformed-JSON attempts on the
 * primary model, then one final attempt on the fallback model. Total cap: 3
 * upstream calls per logical request.
 */
async function callOpenRouter(opts: CallOptions): Promise<unknown> {
  const client = makeClient();
  const primary = opts.model;
  const fallback = fallbackModel();

  const attempts: { model: string; label: "primary-1" | "primary-2" | "fallback" }[] = [
    { model: primary, label: "primary-1" },
    { model: primary, label: "primary-2" },
    { model: fallback, label: "fallback" },
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const response = await client.chat.completions.create({
        model: attempt.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(opts.schemaName, opts.schema),
          },
          { role: "user", content: opts.prompt },
        ],
      });
      return extractOpenRouterContent(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${attempt.label}/${attempt.model}: ${message}`);
      // Non-JSON / parse errors get one more retry per the policy above. Auth, rate-limit, and
      // other transport errors will repeat on retry; that is intentional -- we want the error
      // surface to include all of them so the operator can diagnose.
      continue;
    }
  }
  throw new FleetError(
    `openrouter provider exhausted attempts: ${errors.join("; ")}`,
    8,
    "provider-failure",
  );
}

function buildSystemPrompt(schemaName: string, schema: object): string {
  return [
    `You are responding to a structured-output request named "${schemaName}".`,
    "Return ONE JSON object that strictly satisfies the JSON Schema below.",
    "Do not include markdown, prose, code fences, or any explanation outside the JSON.",
    "Use null where the schema requires it; do not omit required fields.",
    "",
    "JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

/** Exposed for tests. Walks an OpenRouter chat completion and parses the JSON content. */
export function extractOpenRouterContent(
  response: OpenAI.Chat.Completions.ChatCompletion,
): unknown {
  const choice = response.choices[0];
  if (choice === undefined) {
    throw new FleetError(
      "openrouter provider returned no choices",
      8,
      "malformed-output",
    );
  }
  const content = choice.message.content;
  if (content === null || content === undefined || content.length === 0) {
    throw new FleetError(
      "openrouter provider returned empty message content",
      8,
      "malformed-output",
    );
  }
  // Some OpenRouter-hosted models wrap their JSON in ```json fences despite being asked not to;
  // strip a single leading/trailing fence pair before parsing.
  const cleaned = stripJsonFence(content);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FleetError(
      `openrouter provider returned invalid JSON: ${reason}`,
      8,
      "malformed-output",
    );
  }
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u);
  if (fenceMatch !== null && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function makeClient(): OpenAI {
  const apiKey = requireApiKey();
  return new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": HTTP_REFERER,
      "X-Title": X_TITLE,
    },
  });
}

function requireApiKey(): string {
  const key = process.env["OPENROUTER_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new FleetError(
      "openrouter provider requires OPENROUTER_API_KEY; export it before running fleet review",
      4,
      "provider-auth",
    );
  }
  return assertDefined(key, "OPENROUTER_API_KEY guard");
}

function fallbackModel(): string {
  const override = process.env["OPENROUTER_FALLBACK_MODEL"];
  if (override !== undefined && override.length > 0) {
    return override;
  }
  return DEFAULT_FALLBACK_MODEL;
}
