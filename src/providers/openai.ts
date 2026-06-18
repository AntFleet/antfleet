import OpenAI from "openai";
import { FleetError, assertDefined, messageOf } from "../errors.js";
import type { Provider, ProviderCallOptions } from "../provider.js";
import {
  fixPlanJsonSchema,
  patchSuggestionJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider.js";
import {
  FixPlanOutput,
  PatchSuggestionResult,
  ReviewOutput,
  RevalidateOutput,
  TokenUsage,
  fixPlanOutputSchema,
  patchSuggestionOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
} from "../types.js";

export const OPENAI_DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_MODEL = OPENAI_DEFAULT_MODEL;
// GPT-5.5 reasoning-model budget. Asymmetric to Anthropic's MAX_TOKENS=16384
// for two reasons:
//
// 1. `max_completion_tokens` counts BOTH visible output AND invisible
//    reasoning tokens. At 16384, larger code-review prompts saw the
//    earlier GPT-5 default spend the entire budget on reasoning and
//    return empty content with finish_reason="length" — observed in
//    bench-claude-mem PRs #3/#4 after the max_tokens→max_completion_tokens
//    rename. gpt-5.5 is the same reasoning-model family (smoke-tested
//    2026-06-18: response carries a `reasoning_tokens` field, same
//    `max_completion_tokens` semantics), so 32768 still applies to give
//    enough headroom for reasoning + the structured-output JSON.
//
// 2. Anthropic's Messages SDK trips a "use streaming for long requests"
//    guard at max_tokens=32768, so we can't symmetrically bump that side
//    without restructuring the Anthropic call path. The two providers
//    use different fields with different semantics — keeping them
//    asymmetric is correct.
//
// gpt-5.5 rejects the legacy `max_tokens` param with HTTP 400
// ("Unsupported parameter: 'max_tokens' is not supported with this
// model. Use 'max_completion_tokens' instead."), so we send it under
// the new key.
export const OPENAI_MAX_TOKENS = 32768;

// Per-request timeout + retry policy, matched to the Anthropic client
// (ANTHROPIC_CLIENT_OPTS). The OpenAI SDK default is a 600s timeout with 2
// retries — far over the 300s Vercel function ceiling the review crons run
// under, so a single hung call could blow the whole budget. Cap at 240s (the
// same ceiling Anthropic uses) with 3 retries so both providers fail in a
// bounded, symmetric window. Applies to every review, not just the regression
// cron that surfaced the mismatch.
const OPENAI_CLIENT_OPTS = { timeout: 240_000, maxRetries: 3 } as const;

export const openaiProvider: Provider = {
  name: "openai",
  async check(): Promise<string> {
    requireApiKey();
    return `openai ready (default model: ${DEFAULT_MODEL})`;
  },
  async review(
    _root: string,
    prompt: string,
    model: string | null,
    options?: ProviderCallOptions,
  ): Promise<ReviewOutput> {
    const { json } = await callOpenAI({
      prompt,
      model: model ?? DEFAULT_MODEL,
      schemaName: "fleet_review",
      schema: reviewJsonSchema,
      signal: options?.signal ?? null,
    });
    return reviewOutputSchema.parse(json);
  },
  /**
   * Patch Agent v1.5 — symmetric to anthropicProvider.proposePatch.
   * Returns a unified-diff patch or null. Caller enforces diff-hunk filter
   * and 20-line cap.
   */
  async proposePatch(
    _root: string,
    prompt: string,
    model: string | null,
  ): Promise<PatchSuggestionResult> {
    const resolvedModel = model ?? DEFAULT_MODEL;
    const { json, usage } = await callOpenAI({
      prompt,
      model: resolvedModel,
      schemaName: "fleet_patch_suggestion",
      schema: patchSuggestionJsonSchema,
    });
    return { ...patchSuggestionOutputSchema.parse(json), modelId: resolvedModel, usage };
  },
  async fix(_root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    // Plan-only: providers describe a fix; no file mutation here.
    const { json } = await callOpenAI({
      prompt,
      model: model ?? DEFAULT_MODEL,
      schemaName: "fleet_fix_plan",
      schema: fixPlanJsonSchema,
    });
    return fixPlanOutputSchema.parse(json);
  },
  async revalidate(_root: string, prompt: string, model: string | null): Promise<RevalidateOutput> {
    const { json } = await callOpenAI({
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
  signal?: AbortSignal | null;
};

type OpenAICallResult = { json: unknown; usage: TokenUsage | null };

async function callOpenAI(opts: CallOptions): Promise<OpenAICallResult> {
  const apiKey = requireApiKey();
  const client = new OpenAI({ apiKey, ...OPENAI_CLIENT_OPTS });
  const response = await client.chat.completions.create(
    {
      model: opts.model,
      max_completion_tokens: OPENAI_MAX_TOKENS,
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
    },
    opts.signal === null || opts.signal === undefined ? undefined : { signal: opts.signal },
  );
  return { json: extractOpenAIContent(response), usage: extractOpenAIUsage(response) };
}

/** Pull token counts off a chat completion. OpenAI reports prompt_tokens /
 * completion_tokens; map them to the provider-neutral TokenUsage shape. Null
 * when the response omits usage so the patch-cost path degrades gracefully. */
export function extractOpenAIUsage(
  response: OpenAI.Chat.Completions.ChatCompletion,
): TokenUsage | null {
  const u = response.usage;
  if (u === undefined || u === null) return null;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens };
}

/** Exposed for tests. Pulls the JSON content out of a recorded chat completion. */
export function extractOpenAIContent(response: OpenAI.Chat.Completions.ChatCompletion): unknown {
  const choice = response.choices[0];
  if (choice === undefined) {
    throw new FleetError("openai provider returned no choices", 8, "malformed-output");
  }
  const content = choice.message.content;
  if (content === null || content === undefined || content.length === 0) {
    // Include finish_reason and reasoning_tokens so operators can distinguish
    // a reasoning_tokens budget OOM (finish_reason=length) from a real refusal
    // or transport-side empty response. Without these fields every failure
    // looks identical in the persisted PerProviderResult.error string.
    const u = response.usage;
    const reasoningTokens =
      (u as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)
        ?.completion_tokens_details?.reasoning_tokens ?? null;
    const refusal = choice.message.refusal ?? null;
    throw new FleetError(
      `openai provider returned empty message content ` +
        `(finish_reason=${choice.finish_reason}, reasoning_tokens=${reasoningTokens}, ` +
        `prompt_tokens=${u?.prompt_tokens ?? null}, completion_tokens=${u?.completion_tokens ?? null}, ` +
        `refusal=${refusal === null ? "null" : "set"})`,
      8,
      "malformed-output",
    );
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    const reason = messageOf(err);
    throw new FleetError(`openai provider returned invalid JSON: ${reason}`, 8, "malformed-output");
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
