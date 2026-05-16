import Anthropic from "@anthropic-ai/sdk";
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

const DEFAULT_MODEL = "claude-opus-4-7";
// History of this constant:
//   8192 → 16384 (Phase 0 V2 verdict, 142k-char corpus, run 1 truncation)
//   16384 → 32768 (Slice 4b.1 attempt) — REVERTED: the SDK guards any
//   non-streaming call whose token budget could exceed 10 minutes and
//   rejects in <5ms with "Streaming is required for operations that
//   may take longer than 10 minutes". 32k tripped that guard.
//   Back to 16384. Bigger outputs require switching the provider to
//   the streaming API (client.messages.stream + finalMessage). Tracked
//   as a separate follow-up to this slice.
const MAX_TOKENS = 16384;

export const anthropicProvider: Provider = {
  name: "anthropic",
  async check(): Promise<string> {
    requireApiKey();
    return `anthropic ready (default model: ${DEFAULT_MODEL})`;
  },
  async review(_root: string, prompt: string, model: string | null): Promise<ReviewOutput> {
    const json = await callAnthropic({
      prompt,
      model: model ?? DEFAULT_MODEL,
      toolName: "submit_review",
      schema: reviewJsonSchema,
      toolDescription: "Submit the structured review of the feature slice.",
    });
    return reviewOutputSchema.parse(json);
  },
  async fix(_root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    // Week 1: read-only. The provider produces a plan but does not apply it.
    const json = await callAnthropic({
      prompt,
      model: model ?? DEFAULT_MODEL,
      toolName: "submit_fix_plan",
      schema: fixPlanJsonSchema,
      toolDescription:
        "Submit a read-only fix plan. Do not modify files. Patch Bot will apply real fixes in a later week.",
    });
    return fixPlanOutputSchema.parse(json);
  },
  async revalidate(
    _root: string,
    prompt: string,
    model: string | null,
  ): Promise<RevalidateOutput> {
    const json = await callAnthropic({
      prompt,
      model: model ?? DEFAULT_MODEL,
      toolName: "submit_revalidate",
      schema: revalidateJsonSchema,
      toolDescription: "Submit the structured revalidation outcome.",
    });
    return revalidateOutputSchema.parse(json);
  },
};

type CallOptions = {
  prompt: string;
  model: string;
  toolName: string;
  toolDescription: string;
  schema: object;
};

async function callAnthropic(opts: CallOptions): Promise<unknown> {
  const apiKey = requireApiKey();
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
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
  });
  return extractAnthropicToolOutput(response, opts.toolName);
}

/** Exposed for tests. Walks a recorded Anthropic response and pulls out the tool_use input. */
export function extractAnthropicToolOutput(
  response: Anthropic.Messages.Message,
  toolName: string,
): unknown {
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === toolName) {
      return block.input;
    }
  }
  throw new FleetError(
    `anthropic provider returned no ${toolName} tool call`,
    8,
    "malformed-output",
  );
}

function requireApiKey(): string {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new FleetError(
      "anthropic provider requires ANTHROPIC_API_KEY; export it before running fleet review",
      4,
      "provider-auth",
    );
  }
  return assertDefined(key, "ANTHROPIC_API_KEY guard");
}
