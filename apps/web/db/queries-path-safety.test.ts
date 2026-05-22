import { describe, it, expect } from "vitest";
import { extractPathFromPatch, safeRepoRelativePath } from "./queries";

// Patch Agent v1.5 audit response — `extractPathFromPatch` is the LLM-
// controlled fallback inside `loadPatchAcceptanceWork`. A hostile or
// hallucinating model can put `..`, an absolute path, or `/dev/null` in
// the diff header. The value reaches octokit.repos.getContent, so the
// safe-path validator gates traversal even though the install token
// already scopes blast radius to the install's repos.

describe("extractPathFromPatch", () => {
  it("parses the git-standard '+++ b/path' form", () => {
    expect(extractPathFromPatch("--- a/foo.ts\n+++ b/foo.ts\n@@ ...")).toBe("foo.ts");
  });

  it("parses the bare '+++ path' form some tools emit", () => {
    expect(extractPathFromPatch("+++ src/foo.ts\n@@ ...")).toBe("src/foo.ts");
  });

  it("parses the './path' form LLMs sometimes emit", () => {
    expect(extractPathFromPatch("+++ ./src/foo.ts\n@@ ...")).toBe("src/foo.ts");
  });

  it("parses with 'a/' prefix (uncommon but legal)", () => {
    expect(extractPathFromPatch("+++ a/src/foo.ts")).toBe("src/foo.ts");
  });

  it("returns null when the patch has no +++ header", () => {
    expect(extractPathFromPatch("@@ -1,1 +1,1 @@\n-old\n+new\n")).toBeNull();
  });

  it("rejects traversal in the parsed path", () => {
    expect(extractPathFromPatch("+++ b/../../etc/passwd")).toBeNull();
  });

  it("rejects an absolute path", () => {
    expect(extractPathFromPatch("+++ /etc/passwd")).toBeNull();
  });

  it("rejects /dev/null (deletion marker, not a real path)", () => {
    expect(extractPathFromPatch("+++ /dev/null")).toBeNull();
  });
});

describe("safeRepoRelativePath", () => {
  it("accepts a normal repo-relative path", () => {
    expect(safeRepoRelativePath("src/foo.ts")).toBe("src/foo.ts");
  });

  it("trims trailing whitespace", () => {
    expect(safeRepoRelativePath("src/foo.ts   ")).toBe("src/foo.ts");
  });

  it("rejects '..' segments anywhere in the path", () => {
    expect(safeRepoRelativePath("../etc/passwd")).toBeNull();
    expect(safeRepoRelativePath("src/../../etc/passwd")).toBeNull();
    expect(safeRepoRelativePath("src/..")).toBeNull();
  });

  it("rejects absolute (leading-slash) paths", () => {
    expect(safeRepoRelativePath("/etc/passwd")).toBeNull();
  });

  it("rejects null bytes", () => {
    expect(safeRepoRelativePath("src/foo\0.ts")).toBeNull();
  });

  it("rejects empty / pure-whitespace input", () => {
    expect(safeRepoRelativePath("")).toBeNull();
    expect(safeRepoRelativePath("   ")).toBeNull();
  });

  it("rejects backslash-traversal (Windows-style)", () => {
    expect(safeRepoRelativePath("src\\..\\..\\etc\\passwd")).toBeNull();
  });
});
