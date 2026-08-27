// Sidecar-local raw model client — the ONLY model transport for this sidecar.
// specs/SOLIDITY_SIDECAR_SPEC.md §0; reworked per REWORK_PROMPT.md.
//
// TRANSPORT: OpenAI Chat Completions (JSON-object structured output), reached
// through OpenRouter's OpenAI-compatible /api/v1 endpoint. This lets the sidecar
// run GPT models (its default combo) AND still reach Claude via the same route.
// Model combo (default, no env needed): FINDER/stage-A/stage-B = gpt-5.6-sol,
// REFUTER = gpt-5.5. Override per role with SIDECAR_FINDER_MODEL /
// SIDECAR_REFUTER_MODEL, or both with SIDECAR_MODEL. Never route through
// provider.review(); never add another HTTP client.
//
// TRUNCATION SAFETY (REWORK_PROMPT item 5): finish_reason is inspected — a
// "length" (max-tokens) cut-off is reported as truncated:true and surfaced in
// reports, never treated as a complete audit.

import { FleetError } from "../errors.js";

const CHAT_TIMEOUT_MS = 240_000;
// Reasoning models spend completion budget on hidden reasoning tokens, so this is
// generous to avoid truncating the actual JSON payload (see the reasoning-token
// budget-exhaustion note in project memory).
const MAX_COMPLETION_TOKENS = 32_000;

// The sidecar's default GPT combo. gpt-5.6-sol / gpt-5.5 are OpenRouter-only
// (OpenAI-native tops out lower here), so the default endpoint is OpenRouter.
export const AUDIT_DEFAULT_MODEL = "openai/gpt-5.6-sol";
export const REFUTER_DEFAULT_MODEL = "openai/gpt-5.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// Operational routing overrides. Never log key values.
const BASE_URL = (process.env["SIDECAR_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
const REASONING_EFFORT = process.env["SIDECAR_REASONING_EFFORT"] ?? "high";
const SHARED_MODEL_OVERRIDE = process.env["SIDECAR_MODEL"];
const FINDER_MODEL =
  process.env["SIDECAR_FINDER_MODEL"] ?? SHARED_MODEL_OVERRIDE ?? AUDIT_DEFAULT_MODEL;
const REFUTER_MODEL =
  process.env["SIDECAR_REFUTER_MODEL"] ?? SHARED_MODEL_OVERRIDE ?? REFUTER_DEFAULT_MODEL;

function requireApiKey(): string {
  const key =
    process.env["SIDECAR_API_KEY"] ??
    process.env["OPENROUTER_API_KEY"] ??
    process.env["OPENAI_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new FleetError(
      "sidecar model call requires SIDECAR_API_KEY (or OPENROUTER_API_KEY / OPENAI_API_KEY)",
      4,
      "provider-auth",
    );
  }
  return key;
}

// Reference JSON shapes describing the expected finder / refuter payloads. The
// transport now uses json_object output (not API-side schema enforcement), so the
// prompt's AUDIT_JSON_SHAPE + downstream lenient parsing are what shape the
// result; these remain the canonical contract and could back a json_schema strict
// mode later. crossFileDependencies stays first-class here so the two-stage's
// dependency-request field is never treated as optional.
export const finderToolSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "inspected", "crossFileDependencies"],
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
    crossFileDependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "reason"],
        properties: {
          symbol: { type: "string" },
          reason: { type: "string" },
        },
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

/** Minimal structural slice of an OpenAI chat completion — keeps handlers pure/testable. */
export type ChatResponse = {
  choices?: Array<{
    message?: { content?: string | null } | null;
    finish_reason?: string | null;
  }>;
};

export type HandledPayload = {
  payload: unknown;
  /** true when finish_reason === "length": the model was cut off — INCOMPLETE. */
  truncated: boolean;
};

/** Strip a ```json ... ``` fence if the model wrapped its JSON despite instructions. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
}

/**
 * Pure response handler: parse the JSON content of the first choice + truncation
 * flag. Throws on empty/non-JSON content (visible failure, never silent zeros).
 */
export function handleChatResponse(response: ChatResponse, debug = false): HandledPayload {
  const choice = response.choices?.[0];
  const content = choice?.message?.content;
  if (debug) {
    console.error(
      `[model-client] finish=${choice?.finish_reason ?? "?"} content_len=${content?.length ?? 0}`,
    );
  }
  if (content === undefined || content === null || content.trim().length === 0) {
    throw new FleetError("sidecar model call returned empty content", 8, "malformed-output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch {
    throw new FleetError("sidecar model output was not valid JSON", 8, "malformed-output");
  }
  return {
    payload: normalizeToolInput(unwrapNestedToolInput(parsed)),
    truncated: choice?.finish_reason === "length",
  };
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One OpenAI Chat Completions call with JSON-object structured output. Retries
 * transient failures (429 / 5xx / network) a few times with backoff; a caller-
 * supplied signal disables the internal timeout so the caller owns cancellation.
 */
async function callChatJSON(args: {
  prompt: string;
  model: string;
  signal?: AbortSignal | null | undefined;
}): Promise<HandledPayload> {
  const apiKey = requireApiKey();
  const body = JSON.stringify({
    model: args.model,
    messages: [{ role: "user", content: args.prompt }],
    response_format: { type: "json_object" },
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    ...(REASONING_EFFORT.length > 0 ? { reasoning_effort: REASONING_EFFORT } : {}),
  });
  const attempts = 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body,
        signal: args.signal ?? AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (i < attempts - 1) {
          await sleep(1000 * (i + 1));
          continue;
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new FleetError(
          `sidecar model call failed: HTTP ${res.status} ${text.slice(0, 300)}`,
          8,
          "malformed-output",
        );
      }
      const json = (await res.json()) as ChatResponse;
      return handleChatResponse(json, process.env["SIDECAR_DEBUG"] === "1");
    } catch (err) {
      lastErr = err;
      // FleetError = a definitive API/parse failure — do not retry.
      if (err instanceof FleetError || i === attempts - 1) {
        throw err;
      }
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Finder call (default `openai/gpt-5.6-sol`). Parsed payload + truncation flag. */
export function auditModelCall(
  prompt: string,
  options?: { model?: string; signal?: AbortSignal | null },
): Promise<HandledPayload> {
  return callChatJSON({ prompt, model: options?.model ?? FINDER_MODEL, signal: options?.signal });
}

/** Independent adversarial refuter call (default `openai/gpt-5.5`). */
export function refuteModelCall(
  prompt: string,
  options?: { model?: string; signal?: AbortSignal | null },
): Promise<HandledPayload> {
  return callChatJSON({ prompt, model: options?.model ?? REFUTER_MODEL, signal: options?.signal });
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
