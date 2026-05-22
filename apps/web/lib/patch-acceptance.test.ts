import { describe, it, expect } from "vitest";
import {
  extractNewSideLines,
  normalizeForCompare,
  patchContentMatchesFile,
} from "./patch-acceptance";

describe("extractNewSideLines", () => {
  it("returns the new-side lines without the leading '+'", () => {
    const patch =
      "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,2 @@\n-const x = 1;\n+const x = 0;\n+// fixed by Patch Agent\n";
    expect(extractNewSideLines(patch)).toEqual(["const x = 0;", "// fixed by Patch Agent"]);
  });

  it("does not capture the +++ header line", () => {
    const patch = "+++ b/foo.ts\n@@ -1,1 +1,1 @@\n+real-add\n";
    expect(extractNewSideLines(patch)).toEqual(["real-add"]);
  });

  it("returns [] for a deletion-only patch", () => {
    const patch = "@@ -1,2 +1,0 @@\n-a\n-b\n";
    expect(extractNewSideLines(patch)).toEqual([]);
  });

  it("strips trailing blank new-side lines", () => {
    const patch = "@@ -1,1 +1,3 @@\n+useful\n+\n+\n";
    expect(extractNewSideLines(patch)).toEqual(["useful"]);
  });
});

describe("normalizeForCompare", () => {
  it("collapses whitespace runs into single spaces", () => {
    expect(normalizeForCompare("const   a\t= 1;")).toBe("const a = 1;");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeForCompare("   foo   ")).toBe("foo");
  });
});

describe("patchContentMatchesFile", () => {
  const FILE = `import { x } from "./bar";

export function main(): void {
  const counter = 0;
  console.log(counter);
}
`;

  it("matches when the new-side line appears in the file", () => {
    const patch = "@@ -4,1 +4,1 @@\n-  const counter = 1;\n+  const counter = 0;\n";
    expect(patchContentMatchesFile(patch, FILE)).toBe(true);
  });

  it("matches a multi-line new-side block contiguously", () => {
    const patch =
      "@@ -3,3 +3,4 @@\n export function main(): void {\n-  const counter = 1;\n-  console.log(1);\n+  const counter = 0;\n+  console.log(counter);\n}\n";
    expect(patchContentMatchesFile(patch, FILE)).toBe(true);
  });

  it("does not match when the new-side lines are absent", () => {
    const patch = "@@ -4,1 +4,1 @@\n-  const counter = 1;\n+  const counter = 42;\n";
    expect(patchContentMatchesFile(patch, FILE)).toBe(false);
  });

  it("is whitespace-tolerant — tab vs spaces drift", () => {
    const tabFile = "function f() {\n\tconst x = 0;\n\treturn x;\n}\n";
    const spacePatch = "@@ -1,2 +1,2 @@\n-  const x = 1;\n+  const x = 0;\n";
    expect(patchContentMatchesFile(spacePatch, tabFile)).toBe(true);
  });

  it("is whitespace-tolerant — leading indentation drift", () => {
    // Model proposed 2-space indent; file at HEAD has 4-space indent.
    // The post-normalization compare should match.
    const file = "function f() {\n    const x = 0;\n}\n";
    const patch = "@@ -1,1 +1,1 @@\n+  const x = 0;\n";
    expect(patchContentMatchesFile(patch, file)).toBe(true);
  });

  it("is whitespace-tolerant — trailing whitespace ignored", () => {
    const file = "const x = 0;   \n";
    const patch = "@@ -1,1 +1,1 @@\n+const x = 0;\n";
    expect(patchContentMatchesFile(patch, file)).toBe(true);
  });

  it("returns false for a deletion-only patch (no new content to match)", () => {
    const patch = "@@ -4,1 +4,0 @@\n-  const counter = 1;\n";
    expect(patchContentMatchesFile(patch, FILE)).toBe(false);
  });

  it("returns false for an all-whitespace new-side patch", () => {
    const patch = "@@ -1,1 +1,1 @@\n+   \n+\t\n";
    expect(patchContentMatchesFile(patch, FILE)).toBe(false);
  });

  it("requires the lines to appear contiguously — non-adjacent matches don't count", () => {
    // The two +lines exist in the file but are NOT adjacent. Should fail.
    const patch =
      '@@ -3,2 +3,2 @@\n-old1\n-old2\n+import { x } from "./bar";\n+  console.log(counter);\n';
    expect(patchContentMatchesFile(patch, FILE)).toBe(false);
  });

  it("matches even when target line position shifted in the file at HEAD", () => {
    // The patch was originally proposed for line 4. Unrelated edits pushed
    // the line down to line 10 in the merged file. We still want to detect
    // the suggested content.
    const shiftedFile = `// new comment 1
// new comment 2
// new comment 3
// new comment 4
import { x } from "./bar";

export function main(): void {
  const counter = 0;
  console.log(counter);
}
`;
    const patch = "@@ -4,1 +4,1 @@\n-  const counter = 1;\n+  const counter = 0;\n";
    expect(patchContentMatchesFile(patch, shiftedFile)).toBe(true);
  });
});
