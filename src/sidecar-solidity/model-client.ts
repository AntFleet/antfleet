// Sidecar-local raw model client — the ONLY model transport for this sidecar.
// specs/SOLIDITY_SIDECAR_SPEC.md §0; reworked per REWORK_PROMPT.md.
//
// WHY THIS EXISTS: registered providers' .review() hard-parse the strict PR-review
// shape. The sidecar returns its own shapes (finder / refuter), so it gets its
// own path on the SAME @anthropic-ai/sdk transport. Never route through
// provider.review(); never add another HTTP client.
//
// TRUNCATION SAFETY (REWORK_PROMPT item 5): stop_reason is inspected — a
// max_tokens cut-off is reported as truncated:true and surfaced in reports,
// never treated as a complete audit.

import Anthropic from "@anthropic-ai/sdk";
import { FleetError } from "../errors.js";

// Same timeout/retry posture as the PR-review path (see anthropic.ts history):
// a 59-61s boundary blip must not kill a multi-minute audit call.
const CLIENT_OPTS = { timeout: 240_000, maxRetries: 3 } as const;
const MAX_TOKENS = 16384;
export const AUDIT_DEFAULT_MODEL = "claude-opus-4-7";

// Operational routing overrides (same SDK transport): point at a compatible
// endpoint when metered Anthropic credits are unavailable (OpenRouter's
// Anthropic-compat /api route verified). Never log key values.
const BASE_URL = process.env["SIDECAR_BASE_URL"];
const MODEL_OVERRIDE = process.env["SIDECAR_MODEL"];

function requireApiKey(): string {
  const key = process.env["SIDECAR_API_KEY"] ?? process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new FleetError(
      "sidecar audit arm requires ANTHROPIC_API_KEY (or SIDECAR_API_KEY)",
      4,
      "provider-auth",
    );
  }
  return key;
}

export const finderToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "inspected"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "evidence", "reasoning"],
        properties: {
          title: { type: "string" },
          category: { enum: ["security", "bug", "data-loss"] },
          severity: { enum: ["critical", "high", "medium", "low"] },
          confidence: { enum: ["high", "medium", "low"] },
          evidence: {
            type: "array",
            items: {
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
          reasoning: { type: "string" },
          triggerRole: { type: "string" },
          preconditions: { type: "string" },
        },
      },
    },
    inspected: {
      type: "object",
      additionalProperties: false,
      required: ["files", "notes"],
      properties: {
        files: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;

export const refutationToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: {
    verdict: { enum: ["KILLED", "SURVIVED"] },
    reason: { type: "string" },
  },
} as const;

/** Minimal structural slice of an Anthropic message — keeps handlers pure/testable. */
export type RawToolResponse = {
  stop_reason?: string | null;
  content?: Array<{ type: string; input?: unknown }>;
};

export type HandledPayload = {
  payload: unknown;
  /** true when stop_reason === "max_tokens": the audit is INCOMPLETE. */
  truncated: boolean;
};

/**
 * Pure response handler: extract tool payload + truncation flag.
 * Throws when no tool_use block exists (visible failure, never silent zeros).
 */
export function handleToolResponse(response: RawToolResponse, debug = false): HandledPayload {
  if (debug) {
    console.error(
      `[model-client] stop=${response.stop_reason ?? "?"} blocks=[${(response.content ?? []).map((b) => b.type).join(",")}]`,
    );
  }
  for (const block of response.content ?? []) {
    if (block.type === "tool_use") {
      return {
        payload: normalizeToolInput(unwrapNestedToolInput(block.input)),
        truncated: response.stop_reason === "max_tokens",
      };
    }
  }
  throw new FleetError("sidecar model call got no tool call back", 8, "malformed-output");
}

/**
 * Some routes/models wrap the tool payload in an extra single-key layer
 * (`{input: {...}}`, `{submit_audit: {...}}`) — observed live. A valid payload
 * always has 2+ top-level fields, so a single-object-key response is a wrapper.
 */
export function unwrapNestedToolInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    return raw;
  }
  const inner = obj[keys[0] ?? ""];
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    return raw;
  }
  console.error(
    `[model-client] NOTE: unwrapped single-key tool payload layer "${String(keys[0])}"`,
  );
  return inner;
}

/** Some routes return arrays JSON-encoded as strings (observed live). Decode. */
export function normalizeToolInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && value.trimStart().startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          out[key] = parsed;
          console.error(`[model-client] NOTE: normalized stringified-array field "${key}"`);
        }
      } catch {
        // Not decodable — leave as-is; downstream lenient schema handles it visibly.
      }
    }
  }
  return out;
}

async function callWithTool(args: {
  prompt: string;
  model?: string | undefined;
  signal?: AbortSignal | null | undefined;
  toolName: string;
  toolDescription: string;
  schema: object;
}): Promise<HandledPayload> {
  const apiKey = requireApiKey();
  const client = new Anthropic({
    apiKey,
    ...CLIENT_OPTS,
    ...(BASE_URL === null || BASE_URL === undefined ? {} : { baseURL: BASE_URL }),
  });
  const response = await client.messages.create(
    {
      model: args.model ?? MODEL_OVERRIDE ?? AUDIT_DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      tools: [
        {
          name: args.toolName,
          description: args.toolDescription,
          input_schema: args.schema as Anthropic.Messages.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: args.toolName },
      messages: [{ role: "user", content: args.prompt }],
    },
    { signal: args.signal ?? undefined },
  );
  return handleToolResponse(response as RawToolResponse, process.env["SIDECAR_DEBUG"] === "1");
}

/** Finder call. Returns the parsed-as-any tool payload + truncation flag. */
export function auditModelCall(
  prompt: string,
  options?: { model?: string; signal?: AbortSignal | null },
): Promise<HandledPayload> {
  return callWithTool({
    prompt,
    model: options?.model,
    signal: options?.signal,
    toolName: "submit_audit",
    toolDescription: "Submit the structured full-contract fund-extraction audit.",
    schema: finderToolSchema,
  });
}

/** Independent adversarial refuter call (component C). Same spend controls. */
export function refuteModelCall(
  prompt: string,
  options?: { model?: string; signal?: AbortSignal | null },
): Promise<HandledPayload> {
  return callWithTool({
    prompt,
    model: options?.model,
    signal: options?.signal,
    toolName: "submit_refutation",
    toolDescription:
      "Submit your verdict on whether the candidate finding survives adversarial review.",
    schema: refutationToolSchema,
  });
}

/** Debug-only structural summary (no full payload dump — keeps logs sane). */
export function describeShape(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return `${typeof value}:${String(value).slice(0, 80)}`;
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  const obj = value as Record<string, unknown>;
  return `object{${Object.keys(obj)
    .map(
      (k) =>
        `${k}:${typeof obj[k]}${Array.isArray(obj[k]) ? `(${(obj[k] as unknown[]).length})` : ""}`,
    )
    .join(", ")}}`;
}
