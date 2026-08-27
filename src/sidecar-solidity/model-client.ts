// Sidecar-local raw model client — the ONLY model transport for this sidecar.
// specs/SOLIDITY_SIDECAR_SPEC.md §0; reworked per REWORK_PROMPT.md.
//
// TWO TRANSPORTS, ONE PAYLOAD CONTRACT:
//
//  1. CODEX CLI (DEFAULT) — `codex exec` driven non-interactively over the
//     operator's ChatGPT subscription auth (~/.codex). No API key, no per-token
//     spend.
//  2. OpenAI Chat Completions (json_object output) through OpenRouter's
//     OpenAI-compatible /api/v1 endpoint — opt in with SIDECAR_TRANSPORT=http
//     or by setting SIDECAR_BASE_URL. This path (and ONLY this path) needs a key.
//
// The per-role model split is IDENTICAL on both transports: FINDER/stage-A/
// stage-B = gpt-5.6-sol, REFUTER = gpt-5.5, overridable with
// SIDECAR_FINDER_MODEL / SIDECAR_REFUTER_MODEL or both at once with
// SIDECAR_MODEL. Only the id spelling differs — OpenRouter wants the
// `openai/` vendor prefix, codex `-m` wants the bare id — so the codex path
// strips that prefix (see toCodexModelId).
//
// Neither transport uses API-side schema enforcement: the prompt demands strict
// JSON and downstream lenient zod parsing absorbs the rest. Never route through
// provider.review(); never add another HTTP client.
//
// TRUNCATION SAFETY (REWORK_PROMPT item 5): on the HTTP path finish_reason is
// inspected — a "length" (max-tokens) cut-off is reported as truncated:true and
// surfaced in reports, never treated as a complete audit. codex exposes no
// equivalent signal; a cut-off there surfaces as a JSON parse failure instead.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetError } from "../errors.js";

const CHAT_TIMEOUT_MS = 240_000;
// codex is markedly slower than a raw API call (subscription queueing + high
// reasoning effort on ~200k-char finder prompts), so it gets its own budget.
const CODEX_TIMEOUT_MS = 600_000;
// Reasoning models spend completion budget on hidden reasoning tokens, so this is
// generous to avoid truncating the actual JSON payload (see the reasoning-token
// budget-exhaustion note in project memory).
const MAX_COMPLETION_TOKENS = 32_000;

// The sidecar's default GPT combo, spelled with OpenRouter's vendor prefix (the
// HTTP path needs it; toCodexModelId strips it for the codex path).
export const AUDIT_DEFAULT_MODEL = "openai/gpt-5.6-sol";
export const REFUTER_DEFAULT_MODEL = "openai/gpt-5.5";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
// Resolved on PATH; overridable for non-standard install locations.
const CODEX_BIN = process.env["SIDECAR_CODEX_BIN"] ?? "codex";

// Operational routing overrides. Never log key values.
const BASE_URL = (process.env["SIDECAR_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
const REASONING_EFFORT = process.env["SIDECAR_REASONING_EFFORT"] ?? "high";
const SHARED_MODEL_OVERRIDE = process.env["SIDECAR_MODEL"];
const FINDER_MODEL =
  process.env["SIDECAR_FINDER_MODEL"] ?? SHARED_MODEL_OVERRIDE ?? AUDIT_DEFAULT_MODEL;
const REFUTER_MODEL =
  process.env["SIDECAR_REFUTER_MODEL"] ?? SHARED_MODEL_OVERRIDE ?? REFUTER_DEFAULT_MODEL;

/** HTTP transport ONLY — the codex path authenticates via ~/.codex, no key. */
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

// --- codex CLI transport (DEFAULT) -------------------------------------------

/**
 * Pure output handler for `codex exec -o <file>`, which writes ONLY the final
 * assistant message. Mirrors handleChatResponse's parse + normalization
 * defenses. truncated is always false: codex surfaces no finish_reason, so a
 * cut-off shows up here as a JSON parse failure (loud, never a silent zero).
 */
export function handleCodexOutput(text: string): HandledPayload {
  if (text.trim().length === 0) {
    throw new FleetError("sidecar model call returned empty content", 8, "malformed-output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    throw new FleetError("sidecar model output was not valid JSON", 8, "malformed-output");
  }
  return { payload: normalizeToolInput(unwrapNestedToolInput(parsed)), truncated: false };
}

/**
 * OpenRouter spells the ids with a vendor prefix (`openai/gpt-5.6-sol`); the
 * codex CLI wants the bare id (`gpt-5.6-sol`). Same model, same per-role split.
 */
export function toCodexModelId(model: string): string {
  return model.replace(/^openai\//u, "");
}

/**
 * Spawn `codex exec`, feed the prompt over STDIN (finder prompts run to ~200k
 * chars — far past any argv limit) and resolve once it exits 0.
 *
 * Flags: `-o <file>` (final assistant message only), `--skip-git-repo-check`
 * (the sidecar audits checked-out targets from arbitrary cwds) and
 * `-s read-only` (least privilege — the prompt is self-contained, so codex
 * never needs to touch the filesystem). `codex exec` already runs with
 * approval policy "never", so no approval flag is needed.
 */
function runCodexExec(args: {
  argv: readonly string[];
  prompt: string;
  signal?: AbortSignal | null | undefined;
}): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(CODEX_BIN, [...args.argv], { stdio: ["pipe", "pipe", "pipe"] });
    let stderrTail = "";
    let stdoutTail = "";
    let killedReason: string | null = null;

    const stop = (reason: string): void => {
      killedReason = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      stop(`timed out after ${CODEX_TIMEOUT_MS}ms`);
    }, CODEX_TIMEOUT_MS);
    const onAbort = (): void => {
      stop("aborted by caller");
    };
    args.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
    };

    // Both pipes must be drained or the child blocks on a full buffer. Only
    // bounded tails are retained, for diagnostics on a failing exit.
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutTail = (stdoutTail + chunk.toString("utf8")).slice(-2000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err: Error) => {
      cleanup();
      rejectPromise(
        new FleetError(
          `sidecar codex transport could not start \`${CODEX_BIN}\` (is the codex CLI installed and on PATH?): ${err.message}`,
          4,
          "provider-auth",
        ),
      );
    });
    child.on("close", (code: number | null) => {
      cleanup();
      if (killedReason !== null) {
        rejectPromise(
          new FleetError(`sidecar codex transport ${killedReason}`, 8, "malformed-output"),
        );
        return;
      }
      if (code !== 0) {
        const tail = (stderrTail.length > 0 ? stderrTail : stdoutTail).slice(-500);
        rejectPromise(
          new FleetError(
            `sidecar codex transport exited ${String(code)}: ${tail}`,
            8,
            "malformed-output",
          ),
        );
        return;
      }
      resolvePromise();
    });

    // codex can exit before the whole prompt is written (EPIPE) — the close
    // handler above already reports that failure, so never crash here.
    child.stdin.on("error", () => {});
    child.stdin.end(args.prompt);
  });
}

/** One `codex exec` round-trip over the ChatGPT subscription. No API key. */
export async function callCodexExec(args: {
  prompt: string;
  model: string;
  signal?: AbortSignal | null | undefined;
}): Promise<HandledPayload> {
  const dir = await mkdtemp(join(tmpdir(), "antfleet-sidecar-codex-"));
  const outPath = join(dir, "output.json");
  try {
    await runCodexExec({
      argv: [
        "exec",
        "-o",
        outPath,
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-m",
        toCodexModelId(args.model),
      ],
      prompt: args.prompt,
      signal: args.signal,
    });
    const text = await readFile(outPath, "utf8").catch(() => "");
    if (process.env["SIDECAR_DEBUG"] === "1") {
      console.error(
        `[model-client] codex model=${toCodexModelId(args.model)} out_len=${text.length}`,
      );
    }
    return handleCodexOutput(text);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transport selection. DEFAULT is the codex CLI (subscription, no key). The
 * HTTP/OpenRouter path is opt-in: SIDECAR_TRANSPORT=http, or any SIDECAR_BASE_URL
 * (setting a base URL is only meaningful for the HTTP client).
 */
export function useHttpTransport(): boolean {
  return (
    process.env["SIDECAR_TRANSPORT"] === "http" ||
    (process.env["SIDECAR_BASE_URL"] ?? "").length > 0
  );
}

function callModel(args: {
  prompt: string;
  model: string;
  signal?: AbortSignal | null | undefined;
}): Promise<HandledPayload> {
  return useHttpTransport() ? callChatJSON(args) : callCodexExec(args);
}

/** Finder call (default `gpt-5.6-sol`). Parsed payload + truncation flag. */
export function auditModelCall(
  prompt: string,
  options?: { model?: string; signal?: AbortSignal | null },
): Promise<HandledPayload> {
  return callModel({ prompt, model: options?.model ?? FINDER_MODEL, signal: options?.signal });
}

/** Independent adversarial refuter call (default `gpt-5.5`). */
export function refuteModelCall(
  prompt: string,
  options?: { model?: string; signal?: AbortSignal | null },
): Promise<HandledPayload> {
  return callModel({ prompt, model: options?.model ?? REFUTER_MODEL, signal: options?.signal });
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
