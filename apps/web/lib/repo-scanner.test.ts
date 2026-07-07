import { describe, expect, it, vi } from "vitest";
import { scanRepo, planChunks, type ScanOctokit } from "./repo-scanner";
import { MAX_FILE_BYTES } from "./github-files";
import type { ReviewBundle } from "./review-pipeline";
import type { Finding } from "@antfleet/cli/providers/agreement";

const HEAD_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    title: "Unchecked input",
    category: "security",
    severity: "high",
    label: "blocking",
    confidence: "high",
    evidence: [{ path: "src/a.ts", startLine: 10, endLine: 12, symbol: null, quote: null }],
    reasoning: "reasoning",
    reproduction: null,
    recommendation: "fix it",
    whyTestsDoNotAlreadyCoverThis: "no tests",
    suggestedRegressionTest: null,
    minimumFixScope: "small",
    requiresPolicyReview: false,
    upstreamOrigin: null,
    ...overrides,
  };
}

function bundle(over: { agreed?: Finding[]; degraded?: boolean } = {}): ReviewBundle {
  const degraded = over.degraded ?? false;
  return {
    perProvider: [],
    modelIds: {},
    agreed: degraded ? [] : (over.agreed ?? []),
    disagreements: [],
    singleModelTier: [],
    totalMs: 1,
    estimatedCostUsd: 0,
    agreementMode: "unanimous",
    degraded,
    degradedReason: degraded ? "1/2 providers succeeded" : null,
    triage: null,
  };
}

type TreeNode = { path: string; type: string; size: number; sha: string };

// Build a tree node per path. Size defaults to 100 bytes (well under the cap).
function node(path: string, size = 100): TreeNode {
  return { path, type: "blob", size, sha: `sha-${path}` };
}

// Mock octokit. Records every getContent path so tests can assert what was
// fetched. getContent returns the path as the (base64) file body.
function makeOctokit(tree: TreeNode[], opts: { fetchedPaths?: string[] } = {}): ScanOctokit {
  return {
    rest: {
      repos: {
        get: vi.fn(async () => ({ data: { default_branch: "main" } })),
        getContent: vi.fn(async ({ path }: { path: string }) => {
          opts.fetchedPaths?.push(path);
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(`// ${path}\n`, "utf8").toString("base64"),
            },
          };
        }),
      },
      git: {
        getRef: vi.fn(async () => ({ data: { object: { sha: HEAD_SHA } } })),
        getTree: vi.fn(async () => ({ data: { tree } })),
      },
    },
  };
}

describe("scanRepo", () => {
  it("chunks files by directory and de-dupes findings across chunks", async () => {
    const tree: TreeNode[] = [];
    for (const dir of ["srca", "srcb", "srcc"]) {
      const count = dir === "srcc" ? 4 : 8;
      for (let i = 0; i < count; i++) tree.push(node(`${dir}/file${i}.ts`));
    }
    const octokit = makeOctokit(tree);

    // Every chunk surfaces the same finding (same evidence path) — must collapse
    // to one in the de-duplicated result.
    const shared = finding({
      title: "Shared",
      evidence: [{ path: "x.ts", startLine: 1, endLine: 1, symbol: null, quote: null }],
    });
    const reviewPR = vi.fn(async () => bundle({ agreed: [shared] }));

    const result = await scanRepo({ owner: "o", repo: "r", octokit, reviewPR });

    // 3 dirs, each <= MAX_FILES → 3 chunks.
    expect(result.chunkCount).toBe(3);
    expect(reviewPR).toHaveBeenCalledTimes(3);
    expect(result.headSha).toBe(HEAD_SHA);
    expect(result.totalFiles).toBe(20);
    expect(result.degraded).toBe(false);
    // Three identical findings de-duped down to one.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("Shared");
  });

  it("keeps distinct findings from different chunks", async () => {
    const tree = [node("a/one.ts"), node("b/two.ts")];
    const octokit = makeOctokit(tree);
    const reviewPR = vi
      .fn()
      .mockResolvedValueOnce(
        bundle({
          agreed: [
            finding({
              title: "A",
              category: "security",
              evidence: [{ path: "a/one.ts", startLine: 1, endLine: 1, symbol: null, quote: null }],
            }),
          ],
        }),
      )
      .mockResolvedValueOnce(
        bundle({
          agreed: [
            finding({
              title: "B",
              category: "bug",
              evidence: [{ path: "b/two.ts", startLine: 9, endLine: 9, symbol: null, quote: null }],
            }),
          ],
        }),
      );

    const result = await scanRepo({ owner: "o", repo: "r", octokit, reviewPR });
    expect(result.chunkCount).toBe(2);
    expect(result.findings).toHaveLength(2);
  });

  it("keeps the higher-severity finding when two chunks agree (order-independent)", async () => {
    const tree = [node("a/one.ts"), node("b/two.ts")];
    const octokit = makeOctokit(tree);
    // Same category + overlapping evidence path → findingsAgree (severities must
    // be within 1 rank: medium↔high qualifies). Chunk 1 (earlier) yields the
    // MEDIUM one; chunk 2 yields the HIGH one. Result must keep HIGH.
    const ev = [{ path: "shared.ts", startLine: 5, endLine: 5, symbol: null, quote: null }];
    const reviewPR = vi
      .fn()
      .mockResolvedValueOnce(
        bundle({ agreed: [finding({ title: "medium one", severity: "medium", evidence: ev })] }),
      )
      .mockResolvedValueOnce(
        bundle({ agreed: [finding({ title: "high one", severity: "high", evidence: ev })] }),
      );

    const result = await scanRepo({ owner: "o", repo: "r", octokit, reviewPR });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.severity).toBe("high");
    expect(result.findings[0]!.title).toBe("high one");
  });

  it("reports degraded when every chunk review degrades", async () => {
    const tree = [node("a/one.ts"), node("b/two.ts")];
    const octokit = makeOctokit(tree);
    const reviewPR = vi.fn(async () => bundle({ degraded: true }));

    const result = await scanRepo({ owner: "o", repo: "r", octokit, reviewPR });
    expect(result.degraded).toBe(true);
    expect(result.skippedChunks).toBe(result.chunkCount);
    expect(result.findings).toEqual([]);
  });

  it("filters oversize files using the tree node size (never fetches them)", async () => {
    const fetchedPaths: string[] = [];
    const tree = [node("src/small.ts", 200), node("src/huge.ts", MAX_FILE_BYTES + 1)];
    const octokit = makeOctokit(tree, { fetchedPaths });
    const reviewPR = vi.fn(async () => bundle({ agreed: [] }));

    const result = await scanRepo({ owner: "o", repo: "r", octokit, reviewPR });
    expect(fetchedPaths).toContain("src/small.ts");
    expect(fetchedPaths).not.toContain("src/huge.ts");
    expect(result.totalFiles).toBe(1);
  });

  it("never runs more than CHUNK_CONCURRENCY reviews simultaneously", async () => {
    // 8 directories → 8 chunks; concurrency cap is 5.
    const tree: TreeNode[] = [];
    for (let d = 0; d < 8; d++) tree.push(node(`dir${d}/file.ts`));
    const octokit = makeOctokit(tree);

    let inFlight = 0;
    let maxInFlight = 0;
    const reviewPR = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return bundle({ agreed: [] });
    });

    const result = await scanRepo({ owner: "o", repo: "r", octokit, reviewPR });
    expect(result.chunkCount).toBe(8);
    expect(reviewPR).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("returns an empty result when no reviewable files exist", async () => {
    const tree = [node("README.md"), node("pnpm-lock.yaml")]; // md is reviewable, lock is not
    // README.md is reviewable; replace with a non-reviewable extension to get zero.
    const empty = [{ path: "image.png", type: "blob", size: 10, sha: "s" }];
    const octokit = makeOctokit(empty as TreeNode[]);
    const reviewPR = vi.fn(async () => bundle());

    const result = await scanRepo({ owner: "o", repo: "r", octokit, reviewPR });
    expect(result.chunkCount).toBe(0);
    expect(result.totalFiles).toBe(0);
    expect(result.findings).toEqual([]);
    expect(reviewPR).not.toHaveBeenCalled();
    void tree;
  });
});

describe("planChunks", () => {
  it("respects the maxChunks cap", () => {
    const tree: TreeNode[] = [];
    for (let d = 0; d < 20; d++) tree.push(node(`dir${d}/file.ts`));
    const specs = planChunks(tree, 10);
    expect(specs.length).toBe(10);
  });

  it("seals a chunk at MAX_FILES files", () => {
    const tree: TreeNode[] = [];
    for (let i = 0; i < 20; i++) tree.push(node(`src/file${i}.ts`));
    const specs = planChunks(tree, 10);
    // 20 files in one dir, MAX_FILES=15 → 2 chunks (15 + 5).
    expect(specs.length).toBe(2);
    expect(specs[0]!.entries.length).toBe(15);
    expect(specs[1]!.entries.length).toBe(5);
  });
});
