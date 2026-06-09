import { describe, expect, it, vi } from "vitest";
import {
  hashNormalizedDiff,
  measureReplayRun,
  normalizeDiffForApply,
  parsePatchPayload,
  parsesAsUnifiedDiff,
} from "./probe-virtuals-replay";
import { VirtualsClient } from "../lib/virtuals-client";

describe("VirtualsClient", () => {
  it("streams content, first-token latency, and usage without the OpenAI SDK", async () => {
    const chunks = [
      `data: {"model":"openai-gpt-55","choices":[{"delta":{"content":"{\\"patch\\":"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"null}"}}],"usage":{"prompt_tokens":11,"completion_tokens":3}}\n\n`,
      "data: [DONE]\n\n",
    ];
    let now = 100;
    const fetchImpl = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    });
    const client = new VirtualsClient({ apiKey: "test-key", fetchImpl });
    const result = await client.streamChatCompletion(
      { model: "openai-gpt-55", messages: [{ role: "user", content: "prompt" }] },
      () => {
        now += 7;
        return now;
      },
    );

    expect(result.content).toBe('{"patch":null}');
    expect(result.firstTokenMs).toBe(7);
    expect(result.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://compute.virtuals.io/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });
});

describe("probe parsing helpers", () => {
  it("extracts JSON patch payloads", () => {
    const parsed = parsePatchPayload(
      JSON.stringify({ patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n", rationale: null }),
    );
    expect(parsed.jsonOk).toBe(true);
    expect(parsed.patch).toContain("+new");
  });

  it("accepts raw diff content as structurally parseable but not JSON-clean", () => {
    const parsed = parsePatchPayload("@@ -1,1 +1,1 @@\n-old\n+new\n");
    expect(parsed.jsonOk).toBe(false);
    expect(parsed.error).toBe("raw diff response");
    expect(parsed.patch).toContain("+new");
  });

  it("normalizes hunk-only patches for git apply", () => {
    expect(normalizeDiffForApply("@@ -1,1 +1,1 @@\n-old\n+new\n", "src/a.ts")).toBe(
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    );
  });

  it("hashes normalized diff text stably", () => {
    expect(hashNormalizedDiff("x\n")).toBe(hashNormalizedDiff("x\r\n\n"));
  });

  it("requires at least one hunk to parse as a unified diff", () => {
    expect(parsesAsUnifiedDiff("--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n")).toBe(false);
    expect(parsesAsUnifiedDiff("@@ -1,1 +1,1 @@\n-old\n+new\n")).toBe(true);
  });
});

describe("measureReplayRun", () => {
  it("measures parse/apply/hash/cost from a mocked Virtuals response", async () => {
    const patch = "@@ -1,1 +1,1 @@\n-old\n+new\n";
    const applyCheck = vi.fn(async () => ({ ok: true, skipped: false, reason: null }));
    const measured = await measureReplayRun({
      routeId: "gpt5-virtuals",
      findingId: "fid-1",
      run: 1,
      model: "openai-gpt-55",
      responseContent: JSON.stringify({ patch, rationale: null }),
      responseRefusal: null,
      responseUsage: { prompt_tokens: 100, completion_tokens: 20 },
      firstTokenMs: 10,
      completeMs: 50,
      storedPatch: patch,
      rate: { promptUsdPerToken: 0.000001, completionUsdPerToken: 0.000002 },
      applyCheck,
    });

    expect(measured.parsedOk).toBe(true);
    expect(measured.apply.ok).toBe(true);
    expect(measured.diffHashMatch).toBe(true);
    expect(measured.costUsd).toBeCloseTo(0.00014);
    expect(applyCheck).toHaveBeenCalledWith(patch);
  });

  it("does not run git apply when the response declines with patch=null", async () => {
    const applyCheck = vi.fn(async () => ({ ok: true, skipped: false, reason: null }));
    const measured = await measureReplayRun({
      routeId: "opus-virtuals",
      findingId: "fid-2",
      run: 1,
      model: "claude-opus-4-7",
      responseContent: JSON.stringify({ patch: null, rationale: "no clean fix" }),
      responseRefusal: null,
      responseUsage: null,
      firstTokenMs: null,
      completeMs: 25,
      storedPatch: "@@ -1,1 +1,1 @@\n-old\n+new\n",
      rate: null,
      applyCheck,
    });

    expect(measured.parsedOk).toBe(false);
    expect(measured.apply.skipped).toBe(true);
    expect(applyCheck).not.toHaveBeenCalled();
  });
});
