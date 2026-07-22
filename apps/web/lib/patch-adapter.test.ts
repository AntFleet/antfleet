import { describe, it, expect } from "vitest";
import { normalizePatchForApply, locateAnchor } from "./patch-adapter";

describe("normalizePatchForApply", () => {
  const file = `line 1
line 2
def get_prediction_contract(market: Dict) -> str:
    """Determine which prediction contract to use based on the market's token."""
    if market.get("token", "").upper() == "AGBETS":
        return PREDICTION_V2
    return PREDICTION_V1

line 9
line 10`;

  it("passes through a well-formed unified diff (no rebuild)", () => {
    const clean = `diff --git a/src/x.py b/src/x.py
--- a/src/x.py
+++ b/src/x.py
@@ -3,5 +3,5 @@
-def get_prediction_contract(market: Dict) -> str:
-    """Determine which prediction contract to use based on the market's token."""
-    if market.get("token", "").upper() == "AGBETS":
-        return PREDICTION_V2
-    return PREDICTION_V1
+def get_prediction_contract(market: Dict) -> str:
+    """new comment"""
+    if market.get("token", "").upper() == "AGBETS":
+        return PREDICTION_V2
+    return PREDICTION_V1
`;
    const out = normalizePatchForApply({
      patch: clean,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.adapted).toBe(false);
      expect(out.patch).toBe(clean);
    }
  });

  it("passes through a context-ful diff whose stated counts include the context lines", () => {
    // Regression: stated `-3,5 +3,5` counts INCLUDE the 4 context lines; a
    // tally of only the `-`/`+` lines (1 each) would call this dirty and
    // needlessly rebuild it, dropping the context that anchors the hunk.
    const clean = `diff --git a/src/x.py b/src/x.py
--- a/src/x.py
+++ b/src/x.py
@@ -3,5 +3,5 @@
 def get_prediction_contract(market: Dict) -> str:
-    """Determine which prediction contract to use based on the market's token."""
+    """new comment"""
     if market.get("token", "").upper() == "AGBETS":
         return PREDICTION_V2
     return PREDICTION_V1
`;
    const out = normalizePatchForApply({
      patch: clean,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.adapted).toBe(false);
      expect(out.patch).toBe(clean);
    }
  });

  it("passes through a context-ful pure-addition hunk (add side counts context)", () => {
    // `-3,4 +3,5`: 4 context on the old side, same 4 context + 1 inserted
    // line on the new side. Only the added line is a `+` change.
    const clean = `diff --git a/src/x.py b/src/x.py
--- a/src/x.py
+++ b/src/x.py
@@ -3,4 +3,5 @@
 def get_prediction_contract(market: Dict) -> str:
     """Determine which prediction contract to use based on the market's token."""
     if market.get("token", "").upper() == "AGBETS":
+        log("v2 path")
        return PREDICTION_V2
`;
    const out = normalizePatchForApply({
      patch: clean,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.adapted).toBe(false);
      expect(out.patch).toBe(clean);
    }
  });

  it("rebuilds a multi-hunk diff rather than trusting only the last hunk's counts", () => {
    // Two hunks: the whole-patch tally can't validate the last hunk's stated
    // counts, so this must NOT be treated as clean. renderUnifiedDiff only
    // emits a single hunk, so the safe outcome is to rebuild.
    const twoHunks = `diff --git a/src/x.py b/src/x.py
--- a/src/x.py
+++ b/src/x.py
@@ -2,2 +2,2 @@
 line 2
-def get_prediction_contract(market: Dict) -> str:
+def get_prediction_contract(m: Dict) -> str:
@@ -6,1 +6,1 @@
-        return PREDICTION_V2
+        return PREDICTION_V3
`;
    const out = normalizePatchForApply({
      patch: twoHunks,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    // Multi-hunk falls through to the rebuild path (adapted:true) or refuses;
    // either way it is never a silent clean pass-through of the raw input.
    const cleanPassThrough = out.ok && out.adapted === false;
    expect(cleanPassThrough).toBe(false);
  });

  it("rebuilds a patch with mismatched hunk counts using the file as anchor", () => {
    // Hunk header lies: claims old=7 new=11 but actual is 5 / 7.
    const broken = `--- a/src/x.py
+++ b/src/x.py
@@ -100,7 +100,11 @@
-def get_prediction_contract(market: Dict) -> str:
-    """Determine which prediction contract to use based on the market's token."""
-    if market.get("token", "").upper() == "AGBETS":
-        return PREDICTION_V2
-    return PREDICTION_V1
+def get_prediction_contract(market: Dict) -> str:
+    """new comment"""
+    if market.get("token", "").upper() == "AGBETS":
+        return PREDICTION_V2
+    return PREDICTION_V1
+    # tail
+    # tail2
`;
    const out = normalizePatchForApply({
      patch: broken,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.adapted).toBe(true);
      // Anchor must be 3 (where the def appears in the file), NOT 100.
      expect(out.patch).toMatch(/@@ -3,5 \+3,7 @@/u);
      expect(out.patch).toMatch(/^diff --git a\/src\/x\.py b\/src\/x\.py/u);
      expect(out.patch).toContain("--- a/src/x.py");
      expect(out.patch).toContain("+++ b/src/x.py");
    }
  });

  it("rebuilds a patch whose hunk header is just '@@' with no line counts", () => {
    const broken = `--- a/src/x.py
+++ b/src/x.py
@@
-    if market.get("token", "").upper() == "AGBETS":
+    if market.get("token", "").lower() == "agbets":
`;
    const out = normalizePatchForApply({
      patch: broken,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.adapted).toBe(true);
      expect(out.patch).toMatch(/@@ -5,1 \+5,1 @@/u);
    }
  });

  it("refuses to apply when the patch path disagrees with the evidence path", () => {
    const broken = `--- a/src/other.py
+++ b/src/other.py
@@
-foo
+bar
`;
    const out = normalizePatchForApply({
      patch: broken,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/path .* does not match/u);
    }
  });

  it("returns ok:false when the old-side block cannot be located in the file", () => {
    const broken = `--- a/src/x.py
+++ b/src/x.py
@@
-this line does not exist in the file
+replacement
`;
    const out = normalizePatchForApply({
      patch: broken,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/could not locate/u);
    }
  });

  it("returns ok:false when the patch lacks --- / +++ headers", () => {
    const out = normalizePatchForApply({
      patch: "garbage",
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/--- \/ \+\+\+/u);
    }
  });

  it("returns ok:false when the patch has neither - nor + lines", () => {
    const empty = `--- a/src/x.py
+++ b/src/x.py
@@
`;
    const out = normalizePatchForApply({
      patch: empty,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/no - or \+ lines/u);
    }
  });

  it("strips a/ and b/ prefixes when comparing paths", () => {
    const broken = `--- a/src/x.py
+++ b/src/x.py
@@
-    if market.get("token", "").upper() == "AGBETS":
+    if market.get("token", "").lower() == "agbets":
`;
    const out = normalizePatchForApply({
      patch: broken,
      evidencePath: "a/src/x.py", // evidence carries the same prefix
      fileContents: file,
    });
    expect(out.ok).toBe(true);
  });
});

describe("locateAnchor", () => {
  const file = `alpha
beta
  gamma
delta`;

  it("returns 1-based line of the first whitespace-tolerant match", () => {
    expect(locateAnchor(file, ["gamma"])).toBe(3); // tabs/spaces normalized away
    expect(locateAnchor(file, ["beta", "  gamma"])).toBe(2);
  });

  it("returns null when no match", () => {
    expect(locateAnchor(file, ["epsilon"])).toBeNull();
    expect(locateAnchor(file, ["alpha", "epsilon"])).toBeNull();
  });

  it("returns null for an empty / all-whitespace old-side block", () => {
    expect(locateAnchor(file, [])).toBeNull();
    expect(locateAnchor(file, ["   ", "\t"])).toBeNull();
  });

  it("returns null when there are multiple anchor matches (ambiguous)", () => {
    const ambiguous = `return null;
unrelated line
return null;
`;
    expect(locateAnchor(ambiguous, ["return null;"])).toBeNull();
  });
});

describe("normalizePatchForApply ambiguity refusal", () => {
  it("refuses to rebuild a patch whose old-side block matches multiple file locations", () => {
    const file = `line a
return null;
line c
return null;
line e
`;
    const patch = `--- a/src/x.py
+++ b/src/x.py
@@
-return null;
+throw new Error("x");
`;
    const out = normalizePatchForApply({
      patch,
      evidencePath: "src/x.py",
      fileContents: file,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toMatch(/matched \d+ locations/u);
    }
  });
});
