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
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key === undefined || key.length === 0) {
    throw new FleetError("sidecar audit arm requires ANTHROPIC_API_KEY", 4, "provider-auth");
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
  const client = new Anthropic({ apiKey: requireApiKey(), ...CLIENT_OPTS });
  const response = await client.messages.create(
    {
      model: options?.model ?? AUDIT_DEFAULT_MODEL,
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
  for (const block of response.content) {
    if (block.type === "tool_use") {
      return block.input;
    }
  }
  throw new FleetError("sidecar audit arm got no tool call back", 8, "malformed-output");
}
