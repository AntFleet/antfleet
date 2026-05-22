import Anthropic from "@anthropic-ai/sdk";
import { FleetError, assertDefined } from "../errors.js";
import type { Provider } from "../provider.js";
import {
  fixPlanJsonSchema,
  patchSuggestionJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider.js";
import {
  FixPlanOutput,
  PatchSuggestionOutput,
  ReviewOutput,
  RevalidateOutput,
  fixPlanOutputSchema,
  patchSuggestionOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
} from "../types.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MODEL = ANTHROPIC_DEFAULT_MODEL;
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
    return reviewOutputSchema.parse(tolerateReviewShape(json));
  },
  /**
   * Patch Agent v1.5 — per-finding suggested-patch call. Returns either a
   * unified-diff patch the suggestion-block renderer can ship, or null if
   * the model declines (no clean fix, would exceed cap, etc.). The caller
   * is responsible for the diff-hunk filter and the 20-line size cap;
   * this method is the raw provider call only.
   */
  async proposePatch(
    _root: string,
    prompt: string,
    model: string | null,
  ): Promise<PatchSuggestionOutput> {
    const json = await callAnthropic({
      prompt,
      model: model ?? DEFAULT_MODEL,
      toolName: "submit_patch_suggestion",
      schema: patchSuggestionJsonSchema,
      toolDescription:
        "Submit a single-file unified-diff patch that fixes the given finding, " +
        "or return patch=null if no clean fix fits within 20 changed lines.",
    });
    return patchSuggestionOutputSchema.parse(json);
  },
  async fix(_root: string, prompt: string, model: string | null): Promise<FixPlanOutput> {
    // Plan-only: providers describe a fix; applying patches is a separate
    // concern (Patch Bot lives downstream and is not wired in this surface).
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
  async revalidate(_root: string, prompt: string, model: string | null): Promise<RevalidateOutput> {
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

// Per-request timeout and retry policy. PR #7 (2026-05-17) observed an
// Anthropic call returning at exactly 59.3s and the SDK throwing; retry
// on PR synchronize succeeded at 61s. Origin unknown (Anthropic-side
// timeout or upstream proxy boundary near 60s). Explicit 240s ceiling
// keeps us under the 300s Vercel function maxDuration with headroom;
// maxRetries bumped from the SDK default of 2 to 3 so a single 60s
// boundary-blip doesn't fail the whole review.
const ANTHROPIC_CLIENT_OPTS = { timeout: 240_000, maxRetries: 3 } as const;

async function callAnthropic(opts: CallOptions): Promise<unknown> {
  const apiKey = requireApiKey();
  const client = new Anthropic({ apiKey, ...ANTHROPIC_CLIENT_OPTS });
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
      return unwrapNestedInput(block.input);
    }
  }
  throw new FleetError(
    `anthropic provider returned no ${toolName} tool call`,
    8,
    "malformed-output",
  );
}

/**
 * Claude Opus 4.7 intermittently wraps its tool-use payload in an extra
 * single-key layer when called with `tool_choice: { type: "tool" }`.
 * Observed wrapper keys across slice 4b.1 / 4d diagnostics:
 *   - `{ input: { findings, inspected } }`  (echoes the API field name)
 *   - `{ review: { findings, inspected } }` (echoes the tool name stem)
 * Same model, same prompt; the wrapper choice varies between calls.
 *
 * Heuristic: a single top-level key whose value is an object.
 *
 * Safe across all three of our tool schemas (review, fix, revalidate):
 * each requires 2+ top-level fields, so a valid response can never have
 * a single top-level key. Any single-key response must therefore be a
 * wrapper layer. If we ever add a tool with a single-field schema, this
 * heuristic needs revisiting.
 */
/**
 * Coerce malformed review responses into the shape reviewOutputSchema requires.
 * Slice 4d real-PR diagnostics caught a third anthropic failure mode: Opus 4.7
 * sometimes returns `inspected` as a free-form string summary instead of the
 * structured `{ files, symbols, notes }`. Findings parses fine; only the audit-
 * trail field is malformed. Coerce so findings survive and downstream agreement
 * still has two voters.
 *
 * Only applies to review responses (fix/revalidate still strict). Findings
 * stay untouched — that's the load-bearing field and we want to know if it
 * comes back wrong.
 */
export function tolerateReviewShape(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const inspected = obj["inspected"];
  const inspectedOk =
    inspected !== null && typeof inspected === "object" && !Array.isArray(inspected);
  if (!inspectedOk) {
    obj["inspected"] = { files: [], symbols: [], notes: [] };
  }
  return obj;
}

function unwrapNestedInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    return raw;
  }
  const inner = obj[keys[0]!];
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    return raw;
  }
  return inner;
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
