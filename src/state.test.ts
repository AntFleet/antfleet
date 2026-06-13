import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { readFeatures, statePaths } from "./state.js";
import { featureRecordSchema } from "./types.js";

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fleet-state-test-"));
}

const VALID_FEATURE = {
  schemaVersion: 1,
  featureId: "feat_abc123",
  title: "Test feature",
  summary: "A test feature.",
  kind: "library" as const,
  source: "node-package",
  confidence: "high" as const,
  entrypoints: [{ path: "src/index.ts", symbol: null, route: null, command: null }],
  ownedFiles: [{ path: "src/index.ts", reason: "entrypoint" }],
  contextFiles: [],
  tests: [],
  tags: [],
  trustBoundaries: [],
  status: "pending" as const,
  lock: null,
  findingIds: [],
  patchAttemptIds: [],
  analysisHistory: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("readRecords — skip-and-warn on malformed files (T3.8a)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns valid records and skips malformed JSON, warning to stderr", async () => {
    const root = await tmpDir();
    const featuresDir = join(root, "features");
    await mkdir(featuresDir, { recursive: true });

    // Write a valid feature file.
    await writeFile(
      join(featuresDir, "feat_abc123.json"),
      JSON.stringify(VALID_FEATURE, null, 2),
      "utf8",
    );

    // Write a file with invalid JSON (malformed).
    await writeFile(join(featuresDir, "feat_bad.json"), "{ not valid json }", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const paths = statePaths(root);
    const features = await readFeatures(paths);

    // Only the valid feature is returned.
    expect(features).toHaveLength(1);
    expect(features[0]?.featureId).toBe("feat_abc123");

    // A warning was written to stderr mentioning the bad file.
    expect(stderrSpy).toHaveBeenCalledOnce();
    const warnArg = stderrSpy.mock.calls[0]?.[0] as string;
    expect(warnArg).toMatch(/feat_bad\.json/);
    expect(warnArg).toMatch(/malformed state file/);
  });

  it("returns valid records and skips schema-invalid files, warning to stderr", async () => {
    const root = await tmpDir();
    const featuresDir = join(root, "features");
    await mkdir(featuresDir, { recursive: true });

    // Write a valid feature file.
    await writeFile(
      join(featuresDir, "feat_abc123.json"),
      JSON.stringify(VALID_FEATURE, null, 2),
      "utf8",
    );

    // Write a file with valid JSON but failing schema validation.
    await writeFile(
      join(featuresDir, "feat_schema_bad.json"),
      JSON.stringify({ this: "does not match schema" }),
      "utf8",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const paths = statePaths(root);
    const features = await readFeatures(paths);

    expect(features).toHaveLength(1);
    expect(features[0]?.featureId).toBe("feat_abc123");
    expect(stderrSpy).toHaveBeenCalledOnce();
    const warnArg = stderrSpy.mock.calls[0]?.[0] as string;
    expect(warnArg).toMatch(/feat_schema_bad\.json/);
  });

  it("returns all records when no files are malformed", async () => {
    const root = await tmpDir();
    const featuresDir = join(root, "features");
    await mkdir(featuresDir, { recursive: true });

    const feature2 = {
      ...VALID_FEATURE,
      featureId: "feat_def456",
      title: "Second feature",
      entrypoints: [{ path: "src/other.ts", symbol: null, route: null, command: null }],
      ownedFiles: [{ path: "src/other.ts", reason: "entrypoint" }],
    };
    await writeFile(
      join(featuresDir, "feat_abc123.json"),
      JSON.stringify(VALID_FEATURE, null, 2),
      "utf8",
    );
    await writeFile(
      join(featuresDir, "feat_def456.json"),
      JSON.stringify(feature2, null, 2),
      "utf8",
    );

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const paths = statePaths(root);
    const features = await readFeatures(paths);

    expect(features).toHaveLength(2);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("returns [] when directory does not exist (unchanged behavior)", async () => {
    const root = await tmpDir();
    // Don't create the features dir.
    const paths = statePaths(root);
    const features = await readFeatures(paths);
    expect(features).toEqual([]);
  });

  it("warns per-file, not once for all failures", async () => {
    const root = await tmpDir();
    const featuresDir = join(root, "features");
    await mkdir(featuresDir, { recursive: true });

    await writeFile(join(featuresDir, "feat_bad1.json"), "{ bad", "utf8");
    await writeFile(join(featuresDir, "feat_bad2.json"), "{ also bad", "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const paths = statePaths(root);
    const features = await readFeatures(paths);

    expect(features).toHaveLength(0);
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it("non-.json files in the directory are silently ignored (unchanged behavior)", async () => {
    const root = await tmpDir();
    const featuresDir = join(root, "features");
    await mkdir(featuresDir, { recursive: true });

    await writeFile(join(featuresDir, "lockfile"), "binary data", "utf8");
    await writeFile(join(featuresDir, "feat_abc123.json"), JSON.stringify(VALID_FEATURE), "utf8");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const paths = statePaths(root);
    const features = await readFeatures(paths);

    expect(features).toHaveLength(1);
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// Verify featureRecordSchema is importable and validates the fixture above.
describe("featureRecordSchema smoke", () => {
  it("accepts VALID_FEATURE", () => {
    expect(() => featureRecordSchema.parse(VALID_FEATURE)).not.toThrow();
  });
});
