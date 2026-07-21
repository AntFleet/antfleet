import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { insertPostDraftRow } from "./post-draft-store";
import {
  writeFactoryDetectedDraft,
  writeFactoryRepoFoundDraft,
  writeFactoryVerdictDraft,
  writeClaimVerifiedDraft,
  writePostDraft,
  writeRoastPostDraft,
  writeWeeklyFeatureDraft,
} from "./post-drafts";

// The DB sink is a separate module so the wiring can be asserted without a
// database: writePostDraft lazy-imports it, and vi.mock intercepts dynamic
// imports the same as static ones.
vi.mock("./post-draft-store", () => ({
  insertPostDraftRow: vi.fn().mockResolvedValue(true),
}));

const ENV_KEY = "ANTFLEET_DRAFTS_DIR";

describe("writePostDraft (read-only FS guard)", () => {
  const original = process.env[ENV_KEY];
  let tmpdirPath: string | undefined;

  beforeEach(() => {
    delete process.env[ENV_KEY];
    tmpdirPath = undefined;
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
    if (tmpdirPath !== undefined) rmSync(tmpdirPath, { recursive: true, force: true });
  });

  it("resolves to null when ANTFLEET_DRAFTS_DIR is unset (Vercel default)", async () => {
    const result = await writePostDraft({ slug: "x", title: "t", body: "b" });
    expect(result).toBe(null);
  });

  it("does not throw when the target directory cannot be created (EROFS-like)", async () => {
    // Point at a child of an existing non-directory file (/etc/hosts is
    // present on every CI platform we run). mkdir surfaces ENOTDIR fast;
    // the helper must swallow it without raising. Earlier shape used
    // /proc/self/... which timed out on some Linux runners because the
    // kernel did not reject mkdir as quickly as on macOS.
    process.env[ENV_KEY] = "/etc/hosts/no-such/antfleet-drafts";
    await expect(writePostDraft({ slug: "x", title: "t", body: "b" })).resolves.toBe(null);
  });

  it("writes the draft when a writable directory is configured", async () => {
    tmpdirPath = mkdtempSync(path.join(tmpdir(), "antfleet-drafts-"));
    process.env[ENV_KEY] = tmpdirPath;
    const result = await writePostDraft({ slug: "hello", title: "T", body: "B" });
    expect(result).toMatch(/-hello\.md$/);
    expect(result?.startsWith(tmpdirPath)).toBe(true);
  });

  it("writeRoastPostDraft inherits the no-throw / null contract on unset env", async () => {
    await expect(
      writeRoastPostDraft({
        submissionId: "sub-123",
        repoFullName: "ant/fleet",
        pageUrl: "https://example/x",
        findingsCount: 3,
        topSeverity: "high",
        topFindingTitle: "Bad bug",
        submitterHandle: null,
      }),
    ).resolves.toBe(null);
  });
});

describe("writePostDraft DB sink wiring", () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    delete process.env[ENV_KEY];
    vi.mocked(insertPostDraftRow).mockClear();
    vi.mocked(insertPostDraftRow).mockResolvedValue(true);
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("lands a sanitized row in the store even when the file sink is off", async () => {
    await writePostDraft({ slug: "Weekly 2026-W30 Agent!", title: "T", body: "  B  " });
    expect(insertPostDraftRow).toHaveBeenCalledWith({
      slug: "weekly-2026-w30-agent",
      title: "T",
      body: "B",
      source: "weekly",
    });
  });

  it("prefers an explicit source over slug inference", async () => {
    await writePostDraft({ slug: "weekly-2026-w30", title: "T", body: "B", source: "manual" });
    expect(insertPostDraftRow).toHaveBeenCalledWith(expect.objectContaining({ source: "manual" }));
  });

  it("infers source from known slug prefixes and defaults to manual", async () => {
    await writePostDraft({ slug: "outgoing-pr-merged-a-b-1", title: "T", body: "B" });
    await writePostDraft({ slug: "roast-ant-fleet-sub12345", title: "T", body: "B" });
    await writePostDraft({ slug: "factory-AGT-verdict", title: "T", body: "B" });
    await writePostDraft({ slug: "finding-abc-0", title: "T", body: "B" });
    const sources = vi.mocked(insertPostDraftRow).mock.calls.map(([row]) => row.source);
    expect(sources).toEqual(["outgoing_pr", "roast", "factory", "manual"]);
  });

  it("keeps the never-throw contract when the store rejects", async () => {
    vi.mocked(insertPostDraftRow).mockRejectedValueOnce(new Error("db down"));
    await expect(writePostDraft({ slug: "x", title: "t", body: "b" })).resolves.toBe(null);
  });
});

// Voice-pass contract: the BODY is the tweet (titles never leave the operator
// queue), so every generated body must be self-contained — carry a link and,
// where relevant, name its subject — and fit in a post.
describe("draft bodies are post-ready", () => {
  beforeEach(() => {
    delete process.env[ENV_KEY];
    vi.mocked(insertPostDraftRow).mockClear();
    vi.mocked(insertPostDraftRow).mockResolvedValue(true);
  });

  function lastBody(): string {
    const calls = vi.mocked(insertPostDraftRow).mock.calls;
    return calls[calls.length - 1]![0].body;
  }

  const factoryBase = { tokenAddress: "0xabc123", tokenSymbol: "AGT", tokenName: "Agent" };

  it("every generator's body carries a link and fits in a post", async () => {
    await writeRoastPostDraft({
      submissionId: "sub-12345678",
      repoFullName: "ant/fleet",
      pageUrl: "https://www.antfleet.dev/roasts/sub-1234",
      findingsCount: 3,
      topSeverity: "high",
      topFindingTitle: "Bad bug",
      submitterHandle: "someone",
    });
    await writeFactoryDetectedDraft({ ...factoryBase, deployerAddress: "0xdeployer" });
    await writeFactoryRepoFoundDraft({ ...factoryBase, repoFullName: "ant/fleet" });
    await writeFactoryVerdictDraft({
      ...factoryBase,
      findingsCount: 2,
      topSeverity: "high",
      pageUrl: "https://www.antfleet.dev/agents/0xabc123",
    });
    await writeClaimVerifiedDraft({ ...factoryBase, repoFullName: "ant/fleet" });
    await writeWeeklyFeatureDraft({
      agentName: "agent",
      agentTokenAddress: "0xabc123",
      findingTitle: "Bad bug",
      severity: "high",
      summary: "a summary",
    });

    for (const [row] of vi.mocked(insertPostDraftRow).mock.calls) {
      expect(row.body, `${row.slug} body must carry a link`).toMatch(
        /antfleet\.dev|github\.com|https?:\/\//,
      );
      expect(row.body.length, `${row.slug} body must fit in a post`).toBeLessThanOrEqual(280);
    }
  });

  it("roast body names the repo (the title never leaves the queue)", async () => {
    await writeRoastPostDraft({
      submissionId: "sub-12345678",
      repoFullName: "ant/fleet",
      pageUrl: "https://www.antfleet.dev/roasts/sub-1234",
      findingsCount: 1,
      topSeverity: null,
      topFindingTitle: null,
      submitterHandle: null,
    });
    expect(lastBody()).toContain("antfleet roasted ant/fleet");
  });

  it("factory drafts link to the agent page", async () => {
    await writeFactoryDetectedDraft({ ...factoryBase, deployerAddress: "0xdeployer" });
    expect(lastBody()).toContain("antfleet.dev/agents/0xabc123");
    await writeFactoryRepoFoundDraft({ ...factoryBase, repoFullName: "ant/fleet" });
    expect(lastBody()).toContain("antfleet.dev/agents/0xabc123");
  });
});
