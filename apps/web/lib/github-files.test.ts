import { describe, expect, it, vi } from "vitest";
import {
  fetchChangedFilesWith,
  filterReviewableFiles,
  isReviewablePath,
  isWithinSizeLimit,
  REVIEW_BLOCKLIST_BASENAMES,
  REVIEW_BLOCKLIST_PATH_SUFFIXES,
} from "./github-files";

describe("filterReviewableFiles", () => {
  it("drops removed files", () => {
    const result = filterReviewableFiles([
      { filename: "a.ts", status: "modified" },
      { filename: "b.ts", status: "removed" },
      { filename: "c.ts", status: "added" },
    ]);
    expect(result.map((f) => f.filename)).toEqual(["a.ts", "c.ts"]);
  });

  it("drops files with non-review extensions", () => {
    const result = filterReviewableFiles([
      { filename: "src/foo.ts", status: "modified" },
      { filename: "image.png", status: "added" },
      { filename: "config.json", status: "modified" },
      { filename: "build.gradle", status: "modified" },
      { filename: "binary.bin", status: "modified" },
    ]);
    expect(result.map((f) => f.filename)).toEqual(["src/foo.ts", "config.json"]);
  });

  it("caps the file count at MAX_FILES (15)", () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
    }));
    const result = filterReviewableFiles(many);
    expect(result).toHaveLength(15);
    expect(result[0]?.filename).toBe("src/f0.ts");
    expect(result[14]?.filename).toBe("src/f14.ts");
  });
});

describe("isReviewablePath — extension allowlist", () => {
  it.each([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".yml",
    ".yaml",
    ".toml",
    ".sh",
    ".sol",
    ".rs",
    ".go",
    ".py",
  ])("accepts %s", (ext) => {
    expect(isReviewablePath(`src/example${ext}`)).toBe(true);
  });

  it.each([".png", ".gif", ".gradle", ".lock", ".bin", ".pdf", ".zip"])(
    "rejects %s",
    (ext) => {
      expect(isReviewablePath(`src/example${ext}`)).toBe(false);
    },
  );
});

describe("isReviewablePath — basename blocklist", () => {
  it("rejects every entry in REVIEW_BLOCKLIST_BASENAMES even at allowed extensions", () => {
    // Confidence check: the blocklist isn't empty (catches future refactor
    // accidents where the constant is reset).
    expect(REVIEW_BLOCKLIST_BASENAMES.size).toBeGreaterThan(0);
    for (const name of REVIEW_BLOCKLIST_BASENAMES) {
      // At the repo root and nested — both should fail.
      expect(isReviewablePath(name)).toBe(false);
      expect(isReviewablePath(`packages/foo/${name}`)).toBe(false);
    }
  });

  it("rejects package-lock.json even though .json is in the allowlist", () => {
    expect(isReviewablePath("package-lock.json")).toBe(false);
    expect(isReviewablePath("apps/web/package-lock.json")).toBe(false);
    // sanity: regular package.json passes
    expect(isReviewablePath("apps/web/package.json")).toBe(true);
  });

  it("rejects pnpm-lock.yaml even though .yaml is in the allowlist", () => {
    expect(isReviewablePath("pnpm-lock.yaml")).toBe(false);
    expect(isReviewablePath("apps/web/pnpm-lock.yaml")).toBe(false);
  });

  it("rejects LICENSE.md even though .md is in the allowlist", () => {
    expect(isReviewablePath("LICENSE.md")).toBe(false);
    // sanity: README.md passes (it's NOT in the blocklist)
    expect(isReviewablePath("README.md")).toBe(true);
  });
});

describe("isReviewablePath — path-suffix blocklist", () => {
  it.each(REVIEW_BLOCKLIST_PATH_SUFFIXES)(
    "rejects paths containing %s",
    (suffix) => {
      // Construct a realistic path that contains the suffix. Suffixes
      // starting with "/" are directory markers; suffixes starting with "."
      // are filename suffixes.
      const sample = suffix.startsWith("/")
        ? `apps/web${suffix}generated/file.js`
        : `apps/web/src/file${suffix}`;
      expect(isReviewablePath(sample)).toBe(false);
    },
  );

  it("accepts files in plausible source paths that don't hit any blocklist", () => {
    expect(isReviewablePath("apps/web/lib/foo.ts")).toBe(true);
    expect(isReviewablePath("scripts/spike.ts")).toBe(true);
    expect(isReviewablePath("memory/goals.json")).toBe(true);
    expect(isReviewablePath("wiki/flywheel.md")).toBe(true);
    expect(isReviewablePath(".github/workflows/aeon.yml")).toBe(true);
  });
});

describe("isReviewablePath — edge cases", () => {
  it("rejects empty filename", () => {
    expect(isReviewablePath("")).toBe(false);
  });

  it("rejects files with no extension", () => {
    expect(isReviewablePath("Makefile")).toBe(false);
    expect(isReviewablePath("src/Dockerfile")).toBe(false);
  });

  it("handles paths with multiple dots — uses last extension", () => {
    expect(isReviewablePath("file.test.ts")).toBe(true);
    expect(isReviewablePath("file.config.js")).toBe(true);
    // .min.js path-suffix blocklist beats .js extension allowlist
    expect(isReviewablePath("vendor/jquery.min.js")).toBe(false);
  });
});

describe("isWithinSizeLimit", () => {
  it("accepts files <= 20KB", () => {
    expect(isWithinSizeLimit(0)).toBe(true);
    expect(isWithinSizeLimit(20 * 1024)).toBe(true);
  });
  it("rejects files > 20KB", () => {
    expect(isWithinSizeLimit(20 * 1024 + 1)).toBe(false);
    expect(isWithinSizeLimit(1_000_000)).toBe(false);
  });
});

const mkBase64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

describe("fetchChangedFilesWith", () => {
  const mkOctokit = (overrides: {
    files: Array<{ filename: string; status: string; sha: string }>;
    contentByPath: Record<string, { content: string; oversize?: boolean }>;
  }) => ({
    rest: {
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: overrides.files }),
      },
      repos: {
        getContent: vi.fn().mockImplementation(async ({ path }: { path: string }) => {
          const entry = overrides.contentByPath[path];
          if (entry === undefined) {
            throw new Error(`unexpected getContent for ${path}`);
          }
          const raw = entry.oversize ? "x".repeat(60 * 1024) : entry.content;
          return { data: { type: "file", content: mkBase64(raw) } };
        }),
      },
    },
  });

  it("returns content for modified review-extension files", async () => {
    const octokit = mkOctokit({
      files: [
        { filename: "src/a.ts", status: "modified", sha: "shaA" },
        { filename: "src/b.ts", status: "added", sha: "shaB" },
      ],
      contentByPath: {
        "src/a.ts": { content: "export const a = 1;\n" },
        "src/b.ts": { content: "export const b = 2;\n" },
      },
    });
    const result = await fetchChangedFilesWith(octokit, {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "head",
    });
    expect(result).toHaveLength(2);
    expect(result[0]?.filename).toBe("src/a.ts");
    expect(result[0]?.contents).toBe("export const a = 1;\n");
    expect(result[0]?.sha).toBe("shaA");
  });

  it("skips oversize files entirely", async () => {
    const octokit = mkOctokit({
      files: [
        { filename: "tiny.ts", status: "modified", sha: "1" },
        { filename: "huge.ts", status: "modified", sha: "2" },
      ],
      contentByPath: {
        "tiny.ts": { content: "ok" },
        "huge.ts": { content: "", oversize: true },
      },
    });
    const result = await fetchChangedFilesWith(octokit, {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "head",
    });
    expect(result.map((f) => f.filename)).toEqual(["tiny.ts"]);
  });

  it("stops adding files once total content size hits MAX_TOTAL_PROMPT_BYTES", async () => {
    // 10 files at exactly the per-file cap (20KB each) = 200KB. Budget is
    // 150KB, so the 8th file would push us to 160KB > 150KB → break.
    const files = Array.from({ length: 10 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
      sha: `sha${i}`,
    }));
    const contentByPath = Object.fromEntries(
      files.map((f) => [f.filename, { content: "x".repeat(20 * 1024) }]),
    );
    const octokit = mkOctokit({ files, contentByPath });
    const result = await fetchChangedFilesWith(octokit, {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "head",
    });
    expect(result).toHaveLength(7);
    expect(result.map((f) => f.filename)).toEqual([
      "src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts",
      "src/f4.ts", "src/f5.ts", "src/f6.ts",
    ]);
  });

  it("skips entries that aren't of type file (e.g. submodule, dir)", async () => {
    const octokit = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({
            data: [{ filename: "weird.ts", status: "modified", sha: "z" }],
          }),
        },
        repos: {
          getContent: vi.fn().mockResolvedValue({ data: { type: "submodule" } }),
        },
      },
    };
    const result = await fetchChangedFilesWith(octokit, {
      owner: "o",
      repo: "r",
      prNumber: 1,
      headSha: "head",
    });
    expect(result).toEqual([]);
  });
});
