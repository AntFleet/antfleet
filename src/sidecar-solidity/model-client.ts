// Sidecar-local raw model client for the AUDIT arm of the §2 kill-test.
//
// WHY THIS EXISTS (do not "simplify" it away): every registered Provider's
// .review() hard-parses its response through reviewOutputSchema — the strict
// PR-diff-review shape. The audit mode intentionally returns a DIFFERENT shape
// (program-rule factors per finding), so routing it through provider.review()
// would strip or reject exactly the fields the premise test measures.
//
// Spec §0 explicitly allows the sidecar to reuse model clients while keeping
// its own finding path; this module IS that separate path. It deliberately does
// NOT import from src/providers so the PR-reviewer cannot regress and vice
// versa. When/if §3 is authorized this graduates into the sidecar's real
// transport; until then it stays a hand-prototype.

import Anthropic from "@anthropic-ai/sdk";
import { FleetError } from "../errors.js";

// Same timeout/retry posture as the PR-review path (see anthropic.ts history):
// a 59-61s boundary blip must not kill a multi-minute audit call.
const CLIENT_OPTS = { timeout: 240_000, maxRetries: 3 } as const;
const MAX_TOKENS = 16384;
export const AUDIT_DEFAULT_MODEL = "claude-opus-4-7";

// Operational routing overrides (same @anthropic-ai/sdk transport — spec §0
// keeps this the ONLY model client; these just point it at a compatible
// endpoint, e.g. OpenRouter's /api/v1/messages, when metered Anthropic credits
// are unavailable). Defaults: Anthropic direct + AUDIT_DEFAULT_MODEL.
const BASE_URL = process.env["SIDECAR_BASE_URL"];
const MODEL_OVERRIDE = process.env["SIDECAR_MODEL"];

export const auditJsonToolSchema = {
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
          "triggerRole",
          "preconditions",
          "unprivilegedReachable",
          "recoverableUnder1hr",
          "inScope",
          "duplicateOf",
        ],
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
          unprivilegedReachable: { type: "boolean" },
          recoverableUnder1hr: { type: "boolean" },
          inScope: { type: "boolean" },
          duplicateOf: { anyOf: [{ type: "string" }, { type: "null" }] },
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

/**
 * One raw forced-tool-use call. Returns the parsed-as-any tool input; callers
 * apply their own lenient zod schema (auditOutputSchema) downstream.
 */
export async function auditModelCall(
  prompt: string,
  options?: { model?: string; signal?: AbortSignal | null },
): Promise<unknown> {
  const client = new Anthropic({
    apiKey: requireApiKey(),
    ...CLIENT_OPTS,
    ...(BASE_URL === null || BASE_URL === undefined ? {} : { baseURL: BASE_URL }),
  });
  const response = await client.messages.create(
    {
      model: options?.model ?? MODEL_OVERRIDE ?? AUDIT_DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      tools: [
        {
          name: "submit_audit",
          description: "Submit the structured full-contract fund-extraction audit.",
          input_schema: auditJsonToolSchema as unknown as Anthropic.Messages.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: "submit_audit" },
      messages: [{ role: "user", content: prompt }],
    },
    { signal: options?.signal ?? undefined },
  );
  if (process.env["SIDECAR_DEBUG"] === "1") {
    const u = response.usage;
    console.error(
      `[model-client] model=${response.model} stop=${response.stop_reason} blocks=[${response.content.map((b) => b.type).join(",")}] in=${u?.input_tokens ?? "?"} out=${u?.output_tokens ?? "?"}`,
    );
  }
  for (const block of response.content) {
    if (block.type === "tool_use") {
      if (process.env["SIDECAR_DEBUG"] === "1") {
        console.error(`[model-client] raw tool input keys: ${describeShape(block.input)}`);
      }
      return normalizeToolInput(unwrapNestedToolInput(block.input));
    }
  }
  throw new FleetError("sidecar audit arm got no tool call back", 8, "malformed-output");
}

/**
 * Some routes/models return `findings` as a JSON-ENCODED STRING instead of an
 * array (observed live via OpenRouter + claude-sonnet-4.5: `{findings:"[...]",
 * inspected:{...}}` — a 6.6k-output-token response that whole-array parsing
 * would have silently discarded). Normalize at the transport boundary: any
 * top-level string field whose value parses to a JSON array is decoded.
 */
function normalizeToolInput(raw: unknown): unknown {
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

/** Debug-only structural summary (no full payload dump — keeps logs sane). */
function describeShape(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return `${typeof value}:${String(value).slice(0, 80)}`;
  }
  if (Array.isArray(value)) {
    return `array(${value.length})[0]=${describeShape(value[0])}`;
  }
  const obj = value as Record<string, unknown>;
  return `object{${Object.keys(obj)
    .map(
      (k) =>
        `${k}:${typeof obj[k]}${Array.isArray(obj[k]) ? `(${(obj[k] as unknown[]).length})` : ""}`,
    )
    .join(", ")}}`;
}

/**
 * Some models/route combos wrap the tool payload in an extra single-key layer
 * (`{input: {...}}`, `{submit_audit: {...}}`) — same failure mode as
 * anthropic.ts's unwrapNestedInput heuristic. A single top-level object key
 * whose value is an object is treated as a wrapper; our tool schema always has
 * 2+ top-level fields, so a valid payload can never look like this.
 */
function unwrapNestedToolInput(raw: unknown): unknown {
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
