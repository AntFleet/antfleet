import { describe, it, expect, vi } from "vitest";
import { fetchHunkPair, type FetchHunkPairArgs } from "./anatomy-fetcher";

function makeArgs(overrides: Partial<FetchHunkPairArgs> = {}): FetchHunkPairArgs {
  return {
    owner: "TestOrg",
    repo: "test-repo",
    installationId: 12345,
    prSha: "aaa111",
    closureSha: "bbb222",
    file: "src/handler.ts",
    lineStart: 5,
    lineEnd: 8,
    ...overrides,
  };
}

function makeOctokit(responses: Record<string, string>) {
  return {
    rest: {
      repos: {
        getContent: vi.fn().mockImplementation(({ ref }: { ref: string }) => {
          const content = responses[ref];
          if (content === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(content).toString("base64"),
              sha: ref,
            },
          };
        }),
      },
    },
  };
}

const fileContent = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";

describe("fetchHunkPair", () => {
  it("returns both vulnerable and fix hunks on happy path", async () => {
    const octokit = makeOctokit({ aaa111: fileContent, bbb222: fileContent });
    const factory = vi.fn().mockResolvedValue(octokit);

    const result = await fetchHunkPair(makeArgs(), factory);
    expect(result).not.toBeNull();
    expect(result!.vulnerable).not.toBeNull();
    expect(result!.vulnerable!.content).toBe("line5\nline6\nline7\nline8");
    expect(result!.vulnerable!.commitSha).toBe("aaa111");
    expect(result!.fix).not.toBeNull();
    expect(result!.fix!.content).toBe("line5\nline6\nline7\nline8");
  });

  it("returns null when owner is empty", async () => {
    const result = await fetchHunkPair(makeArgs({ owner: "" }));
    expect(result).toBeNull();
  });

  it("returns null when file is empty", async () => {
    const result = await fetchHunkPair(makeArgs({ file: "" }));
    expect(result).toBeNull();
  });

  it("returns null vulnerable when prSha fetch fails (404)", async () => {
    const octokit = makeOctokit({ bbb222: fileContent });
    const factory = vi.fn().mockResolvedValue(octokit);

    const result = await fetchHunkPair(makeArgs(), factory);
    expect(result).not.toBeNull();
    expect(result!.vulnerable).toBeNull();
    expect(result!.fix).not.toBeNull();
  });

  it("returns null fix when closureSha fetch fails (404)", async () => {
    const octokit = makeOctokit({ aaa111: fileContent });
    const factory = vi.fn().mockResolvedValue(octokit);

    const result = await fetchHunkPair(makeArgs(), factory);
    expect(result).not.toBeNull();
    expect(result!.vulnerable).not.toBeNull();
    expect(result!.fix).toBeNull();
  });

  it("returns null when octokit factory throws (auth failure)", async () => {
    const factory = vi.fn().mockRejectedValue(new Error("auth failed"));
    const result = await fetchHunkPair(makeArgs(), factory);
    expect(result).toBeNull();
  });

  it("redacts secrets in returned content", async () => {
    const secretContent =
      "line1\nline2\nline3\nline4\nconst key = 'AKIAIOSFODNN7EXAMPLE1'\nline6\nline7\nline8";
    const octokit = makeOctokit({ aaa111: secretContent, bbb222: secretContent });
    const factory = vi.fn().mockResolvedValue(octokit);

    const result = await fetchHunkPair(makeArgs(), factory);
    expect(result).not.toBeNull();
    expect(result!.vulnerable!.content).toContain("[REDACTED]");
    expect(result!.vulnerable!.content).not.toContain("AKIAIOSFODNN7EXAMPLE1");
  });
});
