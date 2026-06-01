import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChangedFile } from "./github-files";

// Stub the triage pre-pass so each test controls its decision.
const triagePRMock = vi.fn();
vi.mock("./triage-provider", () => ({
  triagePR: (...args: unknown[]) => triagePRMock(...args),
  TRIAGE_COST_USD: 0.001,
}));

// Stub the frontier providers so they never hit the network, and so we can
// assert whether they were called. The agreement / prompt / cost modules are
// pure and used for real.
const anthropicReview = vi.fn();
const openaiReview = vi.fn();
vi.mock("@antfleet/cli/providers/anthropic", () => ({
  anthropicProvider: { name: "anthropic", review: (...a: unknown[]) => anthropicReview(...a) },
  ANTHROPIC_DEFAULT_MODEL: "claude-opus-4-7",
}));
vi.mock("@antfleet/cli/providers/openai", () => ({
  openaiProvider: { name: "openai", review: (...a: unknown[]) => openaiReview(...a) },
  OPENAI_DEFAULT_MODEL: "gpt-5",
}));

import { reviewPR } from "./review-pipeline";

function mkFile(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    filename: "src/x.ts",
    contents: "export const x = 1;",
    status: "modified",
    sha: "sha-1",
    patch: null,
    ...overrides,
  };
}

// Minimal valid-enough ReviewOutput: mergeFindings only reads `.findings`.
function mkOutput() {
  return { findings: [], inspected: { files: [], symbols: [], notes: [] } };
}

function escalate() {
  return {
    worthEscalating: true,
    reason: "logic change",
    modelId: "claude-haiku-4-5",
    ms: 4,
    error: null,
  };
}

beforeEach(() => {
  triagePRMock.mockReset();
  anthropicReview.mockReset();
  openaiReview.mockReset();
});

describe("reviewPR triage pre-pass", () => {
  it("returns an empty bundle and skips the frontier when triage declines a docs-only PR", async () => {
    triagePRMock.mockResolvedValue({
      worthEscalating: false,
      reason: "docs only",
      modelId: "claude-haiku-4-5",
      ms: 3,
      error: null,
    });

    // Docs-only PR — the deterministic source-code guard does not fire, so the
    // triage skip stands.
    const bundle = await reviewPR({
      files: [mkFile({ filename: "README.md", contents: "# docs" })],
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(bundle.agreed).toEqual([]);
    expect(bundle.perProvider).toEqual([]);
    expect(bundle.estimatedCostUsd).toBe(0);
    expect(bundle.degraded).toBe(false);
    expect(bundle.triage?.worthEscalating).toBe(false);
    expect(anthropicReview).not.toHaveBeenCalled();
    expect(openaiReview).not.toHaveBeenCalled();
  });

  it("overrides a triage skip and escalates when any source-code file is present", async () => {
    // Triage votes to skip, but a .ts file is in the changeset. The
    // deterministic guard must force escalation regardless — this is the
    // defense against a confidently-wrong or prompt-injected skip.
    triagePRMock.mockResolvedValue({
      worthEscalating: false,
      reason: "claims docs only",
      modelId: "claude-haiku-4-5",
      ms: 3,
      error: null,
    });
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({
      files: [mkFile({ filename: "apps/web/lib/foo.ts", contents: "export const x = 1;" })],
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(openaiReview).toHaveBeenCalledTimes(1);
    expect(bundle.triage?.worthEscalating).toBe(true);
    expect(bundle.triage?.reason).toMatch(/overridden/u);
    expect(bundle.perProvider).toHaveLength(2);
  });

  it("overrides a triage skip for a CI-workflow-only (.yml) PR", async () => {
    // .yml workflows are a real attack vector (privilege escalation, secret
    // exfiltration) and are NOT in the docs-only skippable allowlist, so a
    // workflow-only PR must escalate even when triage votes to skip.
    triagePRMock.mockResolvedValue({
      worthEscalating: false,
      reason: "claims config only",
      modelId: "claude-haiku-4-5",
      ms: 3,
      error: null,
    });
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({
      files: [
        mkFile({ filename: ".github/workflows/ci.yml", contents: "on: pull_request_target" }),
      ],
      owner: "o",
      repo: "r",
      prNumber: 1,
    });

    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(bundle.triage?.worthEscalating).toBe(true);
    expect(bundle.triage?.reason).toMatch(/overridden/u);
  });

  it("fails open: still runs the frontier when triage errors", async () => {
    triagePRMock.mockResolvedValue({
      worthEscalating: true,
      reason: "triage error — failing open",
      modelId: "claude-haiku-4-5",
      ms: 2,
      error: "anthropic 500 boom",
    });
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(openaiReview).toHaveBeenCalledTimes(1);
    expect(bundle.triage?.error).toBe("anthropic 500 boom");
    // Frontier cost + the triage call's fixed cost.
    expect(bundle.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("includes the triage result on the escalated path", async () => {
    triagePRMock.mockResolvedValue(escalate());
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({ files: [mkFile()], owner: "o", repo: "r", prNumber: 1 });

    expect(bundle.triage?.worthEscalating).toBe(true);
    expect(anthropicReview).toHaveBeenCalledTimes(1);
  });

  it("never calls triage when mode is not unanimous; triage is null", async () => {
    anthropicReview.mockResolvedValue(mkOutput());
    openaiReview.mockResolvedValue(mkOutput());

    const bundle = await reviewPR({
      files: [mkFile()],
      owner: "o",
      repo: "r",
      prNumber: 1,
      mode: "any",
    });

    expect(triagePRMock).not.toHaveBeenCalled();
    expect(bundle.triage).toBeNull();
    expect(anthropicReview).toHaveBeenCalledTimes(1);
    expect(openaiReview).toHaveBeenCalledTimes(1);
  });
});
