import { describe, expect, it, vi } from "vitest";
import {
  fetchChangedFilesWith,
  filterReviewableFiles,
  isWithinSizeLimit,
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
      { filename: "README.md", status: "modified" },
      { filename: "image.png", status: "added" },
      { filename: "config.json", status: "modified" },
      { filename: "build.gradle", status: "modified" },
    ]);
    expect(result.map((f) => f.filename)).toEqual(["src/foo.ts", "config.json"]);
  });

  it("caps the file count at MAX_FILES (20)", () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: "modified",
    }));
    const result = filterReviewableFiles(many);
    expect(result).toHaveLength(20);
    expect(result[0]?.filename).toBe("src/f0.ts");
    expect(result[19]?.filename).toBe("src/f19.ts");
  });

  it("accepts .ts, .tsx, .js, .jsx, .json", () => {
    const files = [
      { filename: "a.ts", status: "modified" },
      { filename: "b.tsx", status: "modified" },
      { filename: "c.js", status: "modified" },
      { filename: "d.jsx", status: "modified" },
      { filename: "e.json", status: "modified" },
    ];
    expect(filterReviewableFiles(files)).toHaveLength(5);
  });
});

describe("isWithinSizeLimit", () => {
  it("accepts files <= 50KB", () => {
    expect(isWithinSizeLimit(0)).toBe(true);
    expect(isWithinSizeLimit(50 * 1024)).toBe(true);
  });
  it("rejects files > 50KB", () => {
    expect(isWithinSizeLimit(50 * 1024 + 1)).toBe(false);
    expect(isWithinSizeLimit(1_000_000)).toBe(false);
  });
});

describe("fetchChangedFilesWith", () => {
  const mkBase64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

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
