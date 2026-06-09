type FetchLike = typeof fetch;

export type VirtualsClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
};

export type VirtualsChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type VirtualsChatCompletionRequest = {
  model: string;
  messages: VirtualsChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
};

export type VirtualsUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type VirtualsChatCompletion = {
  id?: string;
  model?: string;
  choices: Array<{
    index?: number;
    message: {
      role?: string;
      content?: string | null;
      refusal?: string | null;
      tool_calls?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: VirtualsUsage | null;
};

export type VirtualsStreamEvent = {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: VirtualsUsage | null;
};

export type VirtualsStreamResult = {
  content: string;
  refusal: string | null;
  toolCalls: unknown[];
  usage: VirtualsUsage | null;
  model: string;
  firstTokenMs: number | null;
  completeMs: number;
};

export type VirtualsModel = {
  id: string;
  pricing?: Record<string, unknown>;
  [key: string]: unknown;
};

export class VirtualsClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: VirtualsClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env["VIRTUALS_API_KEY"];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("VIRTUALS_API_KEY is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? "https://compute.virtuals.io/v1");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listModels(): Promise<VirtualsModel[]> {
    const resp = await this.fetchImpl(`${this.baseUrl}/models`, {
      method: "GET",
      headers: this.headers(),
    });
    const json = await parseJsonResponse(resp);
    const data = isRecord(json) ? json["data"] : null;
    return Array.isArray(data) ? data.filter(isVirtualsModel) : [];
  }

  async createChatCompletion(
    request: VirtualsChatCompletionRequest,
  ): Promise<VirtualsChatCompletion> {
    const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        ...request,
        temperature: request.temperature ?? 0,
        venice_parameters: { include_venice_system_prompt: false },
      }),
    });
    return (await parseJsonResponse(resp)) as VirtualsChatCompletion;
  }

  async streamChatCompletion(
    request: VirtualsChatCompletionRequest,
    now: () => number = Date.now,
  ): Promise<VirtualsStreamResult> {
    const start = now();
    const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        ...request,
        temperature: request.temperature ?? 0,
        stream: true,
        stream_options: { include_usage: true },
        venice_parameters: { include_venice_system_prompt: false },
      }),
    });
    if (!resp.ok) {
      throw new Error(`Virtuals request failed ${resp.status}: ${await resp.text()}`);
    }
    if (resp.body === null) {
      throw new Error("Virtuals streaming response had no body");
    }

    let content = "";
    let refusal: string | null = null;
    let usage: VirtualsUsage | null = null;
    let model = request.model;
    let firstTokenMs: number | null = null;
    const toolCalls: unknown[] = [];

    for await (const event of parseSse(resp.body)) {
      if (event === "[DONE]") break;
      const parsed = JSON.parse(event) as VirtualsStreamEvent;
      if (typeof parsed.model === "string") model = parsed.model;
      if (parsed.usage !== undefined && parsed.usage !== null) usage = parsed.usage;
      for (const choice of parsed.choices ?? []) {
        const delta = choice.delta;
        if (delta === undefined) continue;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (firstTokenMs === null) firstTokenMs = now() - start;
          content += delta.content;
        }
        if (typeof delta.refusal === "string") {
          if (firstTokenMs === null) firstTokenMs = now() - start;
          refusal = (refusal ?? "") + delta.refusal;
        }
        if (delta.tool_calls !== undefined) {
          if (firstTokenMs === null) firstTokenMs = now() - start;
          toolCalls.push(delta.tool_calls);
        }
      }
    }

    return {
      content,
      refusal,
      toolCalls,
      usage,
      model,
      firstTokenMs,
      completeMs: now() - start,
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}

async function parseJsonResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Virtuals request failed ${resp.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/u);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const data = parseSseData(part);
        if (data !== null) yield data;
      }
    }
    buffer += decoder.decode();
    const data = parseSseData(buffer);
    if (data !== null) yield data;
  } finally {
    reader.releaseLock();
  }
}

function parseSseData(chunk: string): string | null {
  const lines = chunk
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (lines.length === 0) return null;
  return lines.join("\n");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isVirtualsModel(value: unknown): value is VirtualsModel {
  return isRecord(value) && typeof value["id"] === "string";
}
