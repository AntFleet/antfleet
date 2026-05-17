import OpenAI from "openai";
import { FleetError, assertDefined, messageOf } from "../errors.js";
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

export const OPENAI_DEFAULT_MODEL = "gpt-5";
const DEFAULT_MODEL = OPENAI_DEFAULT_MODEL;

export const openaiProvider: Provider = {
  name: "openai",
  async check(): Promise<string> {
    requireApiKey();
    return `openai ready (default model: ${DEFAULT_MODEL})`;
  },
  async review(_root: string, prompt: string, model: string | null): Promise<ReviewOutput> {
    const json = await callOpenAI({
      prompt,
      model: model ?? DEFAULT_MODEL,
      schemaName: "fleet_review",
      schema: reviewJsonSchema,
    });
    return reviewOutputSchema.parse(json);
  },
  async fix(_root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    // Plan-only: providers describe a fix; no file mutation here.
    const json = await callOpenAI({
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
    const json = await callOpenAI({
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

async function callOpenAI(opts: CallOptions): Promise<unknown> {
  const apiKey = requireApiKey();
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: opts.model,
    messages: [{ role: "user", content: opts.prompt }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: opts.schemaName,
        // OpenAI's strict structured outputs reject some JSON schema features (e.g. anyOf without
        // a discriminator) but accept the inherited reviewJsonSchema shape used by codex.
        schema: opts.schema as Record<string, unknown>,
        strict: true,
      },
    },
  });
  return extractOpenAIContent(response);
}

/** Exposed for tests. Pulls the JSON content out of a recorded chat completion. */
export function extractOpenAIContent(
  response: OpenAI.Chat.Completions.ChatCompletion,
): unknown {
  const choice = response.choices[0];
  if (choice === undefined) {
    throw new FleetError(
      "openai provider returned no choices",
      8,
      "malformed-output",
    );
  }
  const content = choice.message.content;
  if (content === null || content === undefined || content.length === 0) {
    throw new FleetError(
      "openai provider returned empty message content",
      8,
      "malformed-output",
    );
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    const reason = messageOf(err);
    throw new FleetError(
      `openai provider returned invalid JSON: ${reason}`,
      8,
      "malformed-output",
    );
  }
}

function requireApiKey(): string {
  const key = process.env["OPENAI_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new FleetError(
      "openai provider requires OPENAI_API_KEY; export it before running fleet review",
      4,
      "provider-auth",
    );
  }
  return assertDefined(key, "OPENAI_API_KEY guard");
}
