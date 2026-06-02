import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, MAX_FILES } from "../lib/github-files";
import {
  buildChunks,
  createChunkPr,
  directoryGroups,
  packGroup,
  parseArgs,
  readChunkFile,
  retryDelayMs,
  slugify,
  splitOwnerRepo,
  type Chunk,
  type FileGroup,
  type GhRequest,
  type GhResponse,
} from "./chunk-repo-for-bench";

describe("parseArgs", () => {
  it("parses all flags with defaults", () => {
    const args = parseArgs(["--source", "a/b", "--bench", "c/d", "--token", "tok"]);
    expect(args).toEqual({
      source: "a/b",
      bench: "c/d",
      token: "tok",
      dryRun: false,
      maxChunks: 40,
      cloneDir: null,
    });
  });

  it("does not require --token under --dry-run", () => {
    const args = parseArgs(["--source", "a/b", "--bench", "c/d", "--dry-run"]);
    expect(args.dryRun).toBe(true);
    expect(args.token).toBe("");
  });

  it("requires --token when not a dry run", () => {
    expect(() => parseArgs(["--source", "a/b", "--bench", "c/d"])).toThrow(/--token/u);
  });

  it("requires --source and --bench", () => {
    expect(() => parseArgs(["--dry-run"])).toThrow(/--source.*--bench|--bench.*--source/u);
  });

  it("does not swallow the next flag as a value", () => {
    // `--source --bench c/d` must NOT set source to "--bench".
    expect(() => parseArgs(["--source", "--bench", "c/d", "--dry-run"])).toThrow(/--source/u);
  });

  it("accepts a valid --max-chunks", () => {
    expect(
      parseArgs(["--source", "a/b", "--bench", "c/d", "--dry-run", "--max-chunks", "7"]).maxChunks,
    ).toBe(7);
  });

  it.each(["abc", "0", "-1", "15abc", "1.5"])("rejects --max-chunks %s", (bad) => {
    expect(() =>
      parseArgs(["--source", "a/b", "--bench", "c/d", "--dry-run", "--max-chunks", bad]),
    ).toThrow(/--max-chunks/u);
  });

  it("captures --clone-dir", () => {
    const args = parseArgs([
      "--source",
      "a/b",
      "--bench",
      "c/d",
      "--dry-run",
      "--clone-dir",
      "/tmp/x",
    ]);
    expect(args.cloneDir).toBe("/tmp/x");
  });
});

describe("slugify", () => {
  it("lowercases, collapses, and trims", () => {
    expect(slugify("Node Route /api/Users")).toBe("node-route-api-users");
  });

  it("handles fleet feature ids", () => {
    expect(slugify("feat_src_a1b2c3d4e5")).toBe("feat-src-a1b2c3d4e5");
  });

  it("caps length at 40 chars", () => {
    expect(slugify("a".repeat(100)).length).toBe(40);
  });

  it("returns empty for all-symbol input", () => {
    expect(slugify("///...///")).toBe("");
  });

  it("does not leave a trailing dash after the length cap", () => {
    // 39 'a's + space + 'b' → slice(0,40) lands on the dash, which must be trimmed.
    expect(slugify(`${"a".repeat(39)} b`).endsWith("-")).toBe(false);
  });
});

describe("splitOwnerRepo", () => {
  it("splits a valid owner/repo", () => {
    expect(splitOwnerRepo("aaronjmars/aeon")).toEqual({ owner: "aaronjmars", repo: "aeon" });
  });

  it.each(["x/..", "../y", "a/b/c", "noslash", "/leading", "trailing/", "a b/c", "a/b$c", ""])(
    "rejects malformed input %s",
    (bad) => {
      expect(() => splitOwnerRepo(bad)).toThrow(/Expected <owner\/repo>/u);
    },
  );

  it("allows dots, dashes, and underscores", () => {
    expect(splitOwnerRepo("my-org/repo.name_2")).toEqual({ owner: "my-org", repo: "repo.name_2" });
  });
});

describe("retryDelayMs", () => {
  it("honors Retry-After seconds", () => {
    expect(retryDelayMs(new Headers({ "retry-after": "12" }))).toBe(12_000);
  });

  it("caps Retry-After at 5 minutes", () => {
    expect(retryDelayMs(new Headers({ "retry-after": "99999" }))).toBe(300_000);
  });

  it("uses x-ratelimit-reset when in the future", () => {
    const resetSec = Math.ceil((Date.now() + 30_000) / 1000);
    const delay = retryDelayMs(new Headers({ "x-ratelimit-reset": String(resetSec) }));
    expect(delay).toBeGreaterThan(20_000);
    expect(delay).toBeLessThanOrEqual(31_000);
  });

  it("falls back to 60s when reset is in the past", () => {
    expect(retryDelayMs(new Headers({ "x-ratelimit-reset": "1" }))).toBe(60_000);
  });

  it("falls back to 60s with no rate-limit headers", () => {
    expect(retryDelayMs(new Headers())).toBe(60_000);
  });
});

const libraryGroup = (paths: string[]): FileGroup => ({
  id: "feat_x",
  title: "Feature X",
  kind: "library",
  paths,
});

describe("filesystem helpers", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chunk-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("readChunkFile", () => {
    it("reads a normal file with its byte length", () => {
      writeFileSync(join(root, "a.ts"), "hello");
      const file = readChunkFile(root, "a.ts");
      expect(file).toEqual({ path: "a.ts", contents: "hello", byteLength: 5 });
    });

    it("rejects a traversal path", () => {
      writeFileSync(join(root, "secret.ts"), "x");
      expect(readChunkFile(root, "../secret.ts")).toBeNull();
      expect(readChunkFile(join(root, "sub"), "../secret.ts")).toBeNull();
    });

    it("rejects an absolute path", () => {
      writeFileSync(join(root, "a.ts"), "x");
      expect(readChunkFile(root, join(root, "a.ts"))).toBeNull();
    });

    it("returns null for a missing file", () => {
      expect(readChunkFile(root, "nope.ts")).toBeNull();
    });

    it("skips a file over the per-file byte cap", () => {
      writeFileSync(join(root, "big.ts"), "a".repeat(MAX_FILE_BYTES + 1));
      expect(readChunkFile(root, "big.ts")).toBeNull();
    });
  });

  describe("packGroup", () => {
    it("packs reviewable files into a single chunk under the caps", () => {
      writeFileSync(join(root, "a.ts"), "aa");
      writeFileSync(join(root, "b.ts"), "bb");
      const chunks = packGroup(root, libraryGroup(["a.ts", "b.ts"]));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    });

    it("splits into multiple chunks when MAX_FILES is exceeded", () => {
      const paths: string[] = [];
      for (let i = 0; i < MAX_FILES + 1; i += 1) {
        const name = `f${i}.ts`;
        writeFileSync(join(root, name), "x");
        paths.push(name);
      }
      const chunks = packGroup(root, libraryGroup(paths));
      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.files).toHaveLength(MAX_FILES);
      expect(chunks[1]!.files).toHaveLength(1);
    });

    it("dedups repeated paths so a chunk never PUTs the same file twice", () => {
      writeFileSync(join(root, "a.ts"), "x");
      const chunks = packGroup(root, libraryGroup(["a.ts", "a.ts", "a.ts"]));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.files).toHaveLength(1);
    });

    it("filters non-reviewable extensions and drops empty chunks", () => {
      writeFileSync(join(root, "a.png"), "x");
      writeFileSync(join(root, "pnpm-lock.yaml"), "x");
      expect(packGroup(root, libraryGroup(["a.png", "pnpm-lock.yaml"]))).toHaveLength(0);
    });

    it("drops oversize files but keeps the rest", () => {
      writeFileSync(join(root, "big.ts"), "a".repeat(MAX_FILE_BYTES + 1));
      writeFileSync(join(root, "small.ts"), "ok");
      const chunks = packGroup(root, libraryGroup(["big.ts", "small.ts"]));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.files.map((f) => f.path)).toEqual(["small.ts"]);
    });
  });

  describe("directoryGroups", () => {
    it("groups reviewable files by top-level directory and skips ignore dirs", () => {
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "lib"));
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "src", "a.ts"), "x");
      writeFileSync(join(root, "src", "b.ts"), "x");
      writeFileSync(join(root, "lib", "c.ts"), "x");
      writeFileSync(join(root, "node_modules", "d.ts"), "x");
      writeFileSync(join(root, "readme.md"), "x");

      const groups = directoryGroups(root);
      const byTitle = Object.fromEntries(groups.map((g) => [g.title, g.paths]));
      expect(Object.keys(byTitle).toSorted()).toEqual([
        "directory:(root)",
        "directory:lib",
        "directory:src",
      ]);
      expect(byTitle["directory:src"]).toEqual(["src/a.ts", "src/b.ts"]);
      // node_modules is never descended into.
      expect(JSON.stringify(groups)).not.toContain("node_modules");
    });
  });

  describe("buildChunks", () => {
    it("appends a chunk index to directory-group titles", () => {
      writeFileSync(join(root, "a.ts"), "x");
      const dirGroup: FileGroup = {
        id: "directory-src",
        title: "directory:src",
        kind: "directory",
        paths: ["a.ts"],
      };
      const chunks = buildChunks(root, [dirGroup]);
      expect(chunks[0]!.featureTitle).toBe("directory:src chunk 1");
    });

    it("leaves semantic feature titles unchanged", () => {
      writeFileSync(join(root, "a.ts"), "x");
      const featGroup: FileGroup = {
        id: "feat_x",
        title: "Feature X",
        kind: "library",
        paths: ["a.ts"],
      };
      const chunks = buildChunks(root, [featGroup]);
      expect(chunks[0]!.featureTitle).toBe("Feature X");
    });
  });
});

// --- createChunkPr: full PR-creation orchestration via an injected GhRequest ---

type RecordedCall = { method: string; path: string; body: unknown };

function fakeRequest(route: (method: string, path: string, body: unknown) => GhResponse): {
  request: GhRequest;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const request: GhRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    return route(method, path, body);
  };
  return { request, calls };
}

const BENCH = { owner: "AntFleet", repo: "x-bench" };
const BASE = { branch: "main", sha: "deadbeef" };

function chunkOf(files: Chunk["files"], overrides: Partial<Chunk> = {}): Chunk {
  return {
    featureId: "feat_config_abc123",
    featureTitle: "Project config",
    featureKind: "config",
    files,
    ...overrides,
  };
}

const isPullsList = (m: string, p: string): boolean => m === "GET" && p.includes("/pulls?head=");
const isRefRead = (m: string, p: string): boolean => m === "GET" && p.includes("/git/ref/heads/");
const isCreateRef = (m: string, p: string): boolean => m === "POST" && p.endsWith("/git/refs");
const isPut = (m: string, p: string): boolean => m === "PUT" && p.includes("/contents/");
const isOpenPr = (m: string, p: string): boolean => m === "POST" && p.endsWith("/pulls");
const isDeleteRef = (m: string, p: string): boolean =>
  m === "DELETE" && p.includes("/git/refs/heads/");

const run = (request: GhRequest, chunk: Chunk, index = 1, total = 2) =>
  createChunkPr(request, BENCH, BASE, chunk, "owner/src", "srcsha", index, total);

describe("createChunkPr", () => {
  it("creates a branch, one commit per file, and opens a PR on the happy path", async () => {
    const { request, calls } = fakeRequest((m, p) => {
      if (isPullsList(m, p)) return { status: 200, body: [] };
      if (isRefRead(m, p)) return { status: 404, body: {} };
      if (isCreateRef(m, p)) return { status: 201, body: {} };
      if (isPut(m, p)) return { status: 201, body: {} };
      if (isOpenPr(m, p)) return { status: 201, body: { number: 7, html_url: "u" } };
      throw new Error(`unexpected ${m} ${p}`);
    });
    const outcome = await run(
      request,
      chunkOf([
        { path: "a.ts", contents: "aa", byteLength: 2 },
        { path: "b.ts", contents: "bb", byteLength: 2 },
      ]),
    );
    expect(outcome).toBe("created");
    expect(calls.filter((c) => isPut(c.method, c.path))).toHaveLength(2);
    expect(calls.some((c) => isDeleteRef(c.method, c.path))).toBe(false);
    // No orphan branch existed, so no DELETE; branch ref created from base sha.
    const createRef = calls.find((c) => isCreateRef(c.method, c.path))!;
    expect((createRef.body as { ref: string; sha: string }).ref).toBe(
      "refs/heads/feat/chunk-001-feat-config-abc123",
    );
    expect((createRef.body as { sha: string }).sha).toBe("deadbeef");
  });

  it("skips (no writes) when a PR already exists for the head branch", async () => {
    const { request, calls } = fakeRequest((m, p) => {
      if (isPullsList(m, p)) return { status: 200, body: [{ number: 1 }] };
      throw new Error(`unexpected ${m} ${p}`);
    });
    const outcome = await run(request, chunkOf([{ path: "a.ts", contents: "x", byteLength: 1 }]));
    expect(outcome).toBe("skipped");
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => isCreateRef(c.method, c.path))).toBe(false);
  });

  it("cleans up an orphan branch (exists, no PR) before recreating it", async () => {
    const { request, calls } = fakeRequest((m, p) => {
      if (isPullsList(m, p)) return { status: 200, body: [] };
      if (isRefRead(m, p)) return { status: 200, body: { object: { sha: "old" } } };
      if (isDeleteRef(m, p)) return { status: 204, body: null };
      if (isCreateRef(m, p)) return { status: 201, body: {} };
      if (isPut(m, p)) return { status: 201, body: {} };
      if (isOpenPr(m, p)) return { status: 201, body: { number: 9, html_url: "u" } };
      throw new Error(`unexpected ${m} ${p}`);
    });
    const outcome = await run(request, chunkOf([{ path: "a.ts", contents: "x", byteLength: 1 }]));
    expect(outcome).toBe("created");
    // The orphan DELETE must happen, and must precede the (re)create of the ref.
    const deleteIdx = calls.findIndex((c) => isDeleteRef(c.method, c.path));
    const createIdx = calls.findIndex((c) => isCreateRef(c.method, c.path));
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(createIdx);
  });

  it("deletes the orphaned ref and fails when PR creation fails", async () => {
    const { request, calls } = fakeRequest((m, p) => {
      if (isPullsList(m, p)) return { status: 200, body: [] };
      if (isRefRead(m, p)) return { status: 404, body: {} };
      if (isCreateRef(m, p)) return { status: 201, body: {} };
      if (isPut(m, p)) return { status: 201, body: {} };
      if (isOpenPr(m, p)) return { status: 422, body: { message: "boom" } };
      if (isDeleteRef(m, p)) return { status: 204, body: null };
      throw new Error(`unexpected ${m} ${p}`);
    });
    const outcome = await run(request, chunkOf([{ path: "a.ts", contents: "x", byteLength: 1 }]));
    expect(outcome).toBe("failed");
    // Cleanup DELETE must come after the failed PR open, so a re-run retries clean.
    const prIdx = calls.findIndex((c) => isOpenPr(c.method, c.path));
    const deleteIdx = calls.findIndex((c) => isDeleteRef(c.method, c.path));
    expect(deleteIdx).toBeGreaterThan(prIdx);
  });

  it("fails without PUT/PR when branch creation fails", async () => {
    const { request, calls } = fakeRequest((m, p) => {
      if (isPullsList(m, p)) return { status: 200, body: [] };
      if (isRefRead(m, p)) return { status: 404, body: {} };
      if (isCreateRef(m, p)) return { status: 422, body: { message: "exists" } };
      throw new Error(`unexpected ${m} ${p}`);
    });
    const outcome = await run(request, chunkOf([{ path: "a.ts", contents: "x", byteLength: 1 }]));
    expect(outcome).toBe("failed");
    expect(calls.some((c) => isPut(c.method, c.path))).toBe(false);
    expect(calls.some((c) => isOpenPr(c.method, c.path))).toBe(false);
    expect(calls.some((c) => isDeleteRef(c.method, c.path))).toBe(false);
  });

  it("base64-encodes file contents with a per-file commit message", async () => {
    let putBody: { message: string; content: string; branch: string } | undefined;
    const { request } = fakeRequest((m, p, body) => {
      if (isPullsList(m, p)) return { status: 200, body: [] };
      if (isRefRead(m, p)) return { status: 404, body: {} };
      if (isCreateRef(m, p)) return { status: 201, body: {} };
      if (isPut(m, p)) {
        putBody = body as typeof putBody;
        return { status: 201, body: {} };
      }
      if (isOpenPr(m, p)) return { status: 201, body: { number: 1, html_url: "u" } };
      throw new Error(`unexpected ${m} ${p}`);
    });
    await run(request, chunkOf([{ path: "src/a.ts", contents: "hello", byteLength: 5 }]));
    expect(putBody?.message).toBe("feat: add src/a.ts");
    expect(putBody?.branch).toBe("feat/chunk-001-feat-config-abc123");
    expect(Buffer.from(putBody!.content, "base64").toString("utf8")).toBe("hello");
  });

  it("treats a failed file PUT as non-fatal and still opens the PR", async () => {
    const { request } = fakeRequest((m, p) => {
      if (isPullsList(m, p)) return { status: 200, body: [] };
      if (isRefRead(m, p)) return { status: 404, body: {} };
      if (isCreateRef(m, p)) return { status: 201, body: {} };
      if (isPut(m, p)) return { status: 500, body: { message: "flaky" } };
      if (isOpenPr(m, p)) return { status: 201, body: { number: 1, html_url: "u" } };
      throw new Error(`unexpected ${m} ${p}`);
    });
    const outcome = await run(request, chunkOf([{ path: "a.ts", contents: "x", byteLength: 1 }]));
    expect(outcome).toBe("created");
  });

  it("falls back to a chunk-index branch slug when the feature id has no usable chars", async () => {
    let refBody: { ref: string } | undefined;
    const { request } = fakeRequest((m, p, body) => {
      if (isPullsList(m, p)) return { status: 200, body: [] };
      if (isRefRead(m, p)) return { status: 404, body: {} };
      if (isCreateRef(m, p)) {
        refBody = body as typeof refBody;
        return { status: 201, body: {} };
      }
      if (isPut(m, p)) return { status: 201, body: {} };
      if (isOpenPr(m, p)) return { status: 201, body: { number: 1, html_url: "u" } };
      throw new Error(`unexpected ${m} ${p}`);
    });
    await run(
      request,
      chunkOf([{ path: "a.ts", contents: "x", byteLength: 1 }], { featureId: "///" }),
      3,
      5,
    );
    expect(refBody?.ref).toBe("refs/heads/feat/chunk-003-chunk-3");
  });
});
