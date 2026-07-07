import Anthropic from "@anthropic-ai/sdk";
import { FleetError, assertDefined } from "../errors.js";
import type { Provider, ProviderCallOptions } from "../provider.js";
import { fixPlanJsonSchema, reviewJsonSchema, revalidateJsonSchema } from "../provider.js";
import {
  FixPlanOutput,
  ReviewOutput,
  RevalidateOutput,
  TokenUsage,
  fixPlanOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
} from "../types.js";
import {
  extractAnthropicToolOutput,
  extractAnthropicUsage,
  tolerateReviewShape,
} from "./anthropic.js";

// GLM 5.2 (Zhipu / z.ai) — served on the Anthropic-compatible Messages
// endpoint, so this adapter reuses the @anthropic-ai/sdk transport with the
// base URL + key pointed at z.ai. Reusing the transport client is not reusing
// the model: GLM is a genuinely independent voter (mergeFindings keys agreement
// off the distinct providerName). The Coding-Plan key is billed on this
// Anthropic-compat endpoint; the OpenAI-compat /paas/v4 endpoint bills
// pay-as-you-go and errors on an empty balance, so we do NOT use it.
//
// Verified live 2026-07-07: base https://api.z.ai/api/anthropic, header
// x-api-key (the SDK sends it by default), anthropic-version 2023-06-01,
// model glm-5.2 — HTTP 200, 78/78 parseable JSON in the eval.
export const ZHIPU_DEFAULT_MODEL = "glm-5.2";
const DEFAULT_MODEL = ZHIPU_DEFAULT_MODEL;
const DEFAULT_BASE_URL = "https://api.z.ai/api/anthropic";

// GLM 5.2 output budget. Kept at the anthropic.ts MAX_TOKENS=16384 value:
// GLM runs on the same Anthropic Messages transport, so the same SDK guard
// (non-streaming calls whose token budget could exceed 10 minutes are rejected
// in <5ms) applies. 16384 stays under that guard and is ample for the
// structured-output JSON.
const MAX_TOKENS = 16384;

// Per-request timeout and retry policy, matched to ANTHROPIC_CLIENT_OPTS: 240s
// ceiling keeps us under the 300s Vercel function maxDuration with headroom,
// and maxRetries=3 absorbs a single boundary-blip without failing the review.
const ZHIPU_CLIENT_OPTS = { timeout: 240_000, maxRetries: 3 } as const;

export const zhipuProvider: Provider = {
  name: "zhipu",
  async check(): Promise<string> {
    requireApiKey();
    return `zhipu ready (default model: ${DEFAULT_MODEL})`;
  },
  async review(
    _root: string,
    prompt: string,
    model: string | null,
    options?: ProviderCallOptions,
  ): Promise<ReviewOutput> {
    const { json } = await callZhipuReview({
      prompt,
      model: model ?? DEFAULT_MODEL,
      toolName: "submit_review",
      schema: reviewJsonSchema,
      toolDescription: "Submit the structured review of the feature slice.",
      signal: options?.signal ?? null,
    });
    return reviewOutputSchema.parse(tolerateReviewShape(json));
  },
  async fix(_root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    // Plan-only: providers describe a fix; applying patches is a separate
    // concern (Patch Agent lives downstream and is not wired in this surface).
    const { json } = await callZhipuReview({
      prompt,
      model: model ?? DEFAULT_MODEL,
      toolName: "submit_fix_plan",
      schema: fixPlanJsonSchema,
      toolDescription:
        "Submit a read-only fix plan. Do not modify files. Patch Agent will apply real fixes in a later week.",
    });
    return fixPlanOutputSchema.parse(json);
  },
  async revalidate(_root: string, prompt: string, model: string | null): Promise<RevalidateOutput> {
    const { json } = await callZhipuReview({
      prompt,
      model: model ?? DEFAULT_MODEL,
      toolName: "submit_revalidate",
      schema: revalidateJsonSchema,
      toolDescription: "Submit the structured revalidation outcome.",
    });
    return revalidateOutputSchema.parse(json);
  },
  // proposePatch intentionally omitted — GLM participates only as a
  // reviewer/adjudicator, not in the suggested-patch lane.
};

type CallOptions = {
  prompt: string;
  model: string;
  toolName: string;
  toolDescription: string;
  schema: object;
  signal?: AbortSignal | null;
};

type ZhipuCallResult = { json: unknown; usage: TokenUsage | null };

/** Build the configured z.ai Anthropic-compat client. Exposed so Build B's
 * adjudication module can reuse the exact transport config (base URL, key,
 * timeout, retries) without re-deriving it. */
export function makeZhipuClient(): Anthropic {
  const apiKey = requireApiKey();
  const baseURL = process.env["ZHIPU_BASE_URL"] ?? DEFAULT_BASE_URL;
  return new Anthropic({ apiKey, baseURL, ...ZHIPU_CLIENT_OPTS });
}

/** Resolve the GLM model id, honoring the ZHIPU_MODEL override. */
export function resolveZhipuModel(model?: string | null): string {
  if (model !== undefined && model !== null && model.length > 0) return model;
  const override = process.env["ZHIPU_MODEL"];
  if (override !== undefined && override.length > 0) return override;
  return DEFAULT_MODEL;
}

async function callZhipuReview(opts: CallOptions): Promise<ZhipuCallResult> {
  const client = makeZhipuClient();
  const response = await client.messages.create(
    {
      model: opts.model,
      max_tokens: MAX_TOKENS,
      tools: [
        {
          name: opts.toolName,
          description: opts.toolDescription,
          // Anthropic typings expect `Tool.InputSchema`; the underlying JSON schema works as-is.
          input_schema: opts.schema as Anthropic.Messages.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: opts.toolName },
      messages: [{ role: "user", content: opts.prompt }],
    },
    opts.signal === null || opts.signal === undefined ? undefined : { signal: opts.signal },
  );
  return {
    json: extractAnthropicToolOutput(response, opts.toolName),
    usage: extractAnthropicUsage(response),
  };
}

export type ZhipuJudgment = { text: string; usage: TokenUsage | null };

/**
 * Low-level, reusable GLM call for Build B's adjudication module. Makes an
 * arbitrary GLM judgment call (e.g. confirm/reject a finding) WITHOUT going
 * through the full review() Finding pipeline — returns the raw text content
 * plus token usage. Empty-content guard mirrors the review path so a
 * reasoning-token starvation surfaces as a FleetError rather than a silent "".
 */
export async function callZhipu(
  system: string,
  user: string,
  opts?: ProviderCallOptions,
): Promise<ZhipuJudgment> {
  const client = makeZhipuClient();
  const response = await client.messages.create(
    {
      model: resolveZhipuModel(),
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    },
    opts?.signal === null || opts?.signal === undefined ? undefined : { signal: opts.signal },
  );
  const text = extractZhipuText(response);
  return { text, usage: extractAnthropicUsage(response) };
}

/** Pull the concatenated text content off a GLM message. Throws on empty
 * content (reasoning-token starvation / refusal) so callers see a bounded
 * failure instead of an empty string. Exposed for tests. */
export function extractZhipuText(response: Anthropic.Messages.Message): string {
  let text = "";
  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }
  if (text.trim().length === 0) {
    throw new FleetError("zhipu provider returned empty text content", 8, "malformed-output");
  }
  return text;
}

function requireApiKey(): string {
  const key = process.env["ZHIPU_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new FleetError(
      "zhipu provider requires ZHIPU_API_KEY; export it before running fleet review",
      4,
      "provider-auth",
    );
  }
  return assertDefined(key, "ZHIPU_API_KEY guard");
}
