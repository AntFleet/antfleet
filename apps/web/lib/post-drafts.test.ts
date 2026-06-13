import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePostDraft, writeRoastPostDraft } from "./post-drafts";

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
