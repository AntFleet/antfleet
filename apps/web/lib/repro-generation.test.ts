import { describe, it, expect } from "vitest";
import {
  generateReproTest,
  buildReproTestPrompt,
  isSafeReproPath,
  REPRO_FILE_MAX_BYTES,
  type ReproProposingProvider,
  type GenerateReproTestArgs,
} from "./repro-generation";
import { reproTestOutputSchema, type ReproTestSuggestion } from "@antfleet/cli/types";
import type { Finding } from "./review-types";
import type { ChangedFile } from "./github-files";

// Repro-test generation (issue #133, Build 2) — orchestrator unit tests. The
// provider call is mocked because this build ships only the generation
// primitive; wiring to a live provider + the runner happens in Build 2b. These
// tests pin the validation paths (cmd allowlist, metacharacter reject, path
// safety, size cap, decline, failure isolation) 2b depends on.

const stubFinding = (overrides: Partial<Finding> = {}): Finding => ({
  title: "SQL injection in user lookup",
  category: "security",
  severity: "high",
  label: "blocking",
  confidence: "high",
  evidence: [{ path: "src/db.ts", startLine: 10, endLine: 12, symbol: "lookup", quote: null }],
  reasoning: "User input is concatenated into a raw SQL string.",
  reproduction: "Send `' OR 1=1 --` as the username.",
  recommendation: "Use a parameterized query.",
  whyTestsDoNotAlreadyCoverThis: "No test exercises malicious input.",
  suggestedRegressionTest: null,
  minimumFixScope: "Parameterize the query in lookup().",
  requiresPolicyReview: false,
  upstreamOrigin: null,
  ...overrides,
});

const STUB_FILE_CONTENTS =
  "export function lookup(name: string) {\n  return db.query(`SELECT * FROM users WHERE name = '${name}'`);\n}\n";

const stubFile = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  filename: "src/db.ts",
  contents: STUB_FILE_CONTENTS,
  status: "modified",
  sha: "abc",
  patch: "@@ -1,3 +1,3 @@\n export function lookup(name: string) {\n",
  ...overrides,
});

// Build a mock repro provider. The impl returns the raw model output; the
// harness attaches a synthesized modelId so the orchestrator's threading is
// exercised (mirrors patch-generation.test.ts's buildProvider).
const buildProvider = (
  name: string,
  impl: () => Promise<Omit<ReproTestSuggestion, "modelId">>,
): ReproProposingProvider => ({
  name,
  async proposeReproTest() {
    const result = await impl();
    return { ...result, modelId: `${name}-test-model` };
  },
});

const baseArgs = (overrides: Partial<GenerateReproTestArgs> = {}): GenerateReproTestArgs => ({
  reviewId: "rev-1",
  findings: [stubFinding()],
  findingIds: ["fid-1"],
  changedFiles: [stubFile()],
  provider: buildProvider("anthropic", async () => ({
    file: { path: "repro_test.py", contents: "assert True\n" },
    cmd: "pytest repro_test.py",
    rationale: null,
  })),
  ...overrides,
});

describe("buildReproTestPrompt", () => {
  it("(a) embeds the finding fields, the source window, and the exit-0-on-vuln rule", () => {
    const excerpt = { text: "return db.query(`...${name}...`);", firstLine: 8 };
    const prompt = buildReproTestPrompt(stubFinding(), excerpt);
    // Finding fields.
    expect(prompt).toContain("SQL injection in user lookup");
    expect(prompt).toContain("src/db.ts:10-12");
    expect(prompt).toContain("User input is concatenated into a raw SQL string.");
    expect(prompt).toContain("Use a parameterized query.");
    expect(prompt).toContain("Send `' OR 1=1 --` as the username.");
    // Source window block.
    expect(prompt).toContain("SOURCE — exact current (UNPATCHED) contents");
    expect(prompt).toContain("starting at line 8");
    expect(prompt).toContain("return db.query");
    // Exit-0-on-vuln HARD rule — the load-bearing convention for Build 2b.
    expect(prompt).toContain("exit 0 == the bug reproduces");
    expect(prompt).toContain("NON-ZERO once the finding's recommended fix is applied");
  });

  it("renders '(none provided)' when reproduction is null and omits SOURCE when no excerpt", () => {
    const prompt = buildReproTestPrompt(stubFinding({ reproduction: null }), null);
    expect(prompt).toContain("(none provided)");
    expect(prompt).not.toContain("SOURCE — exact current");
  });
});

describe("generateReproTest — happy path", () => {
  it("(b) a valid model output parses + validates into a ReproTestSuggestion", async () => {
    const result = await generateReproTest(baseArgs());
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0];
    expect(p?.findingId).toBe("fid-1");
    expect(p?.skipReason).toBeNull();
    expect(p?.reproTest?.cmd).toBe("pytest repro_test.py");
    expect(p?.reproTest?.file?.path).toBe("repro_test.py");
    expect(p?.reproTest?.modelId).toBe("anthropic-test-model");
  });

  it("accepts a file=null repro when cmd needs no new file (bare curl to localhost)", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: null,
      cmd: "curl -sf http://localhost:8080/admin",
      rationale: null,
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(result.proposals[0]?.reproTest?.cmd).toBe("curl -sf http://localhost:8080/admin");
    expect(result.proposals[0]?.reproTest?.file).toBeNull();
  });
});

describe("generateReproTest — cmd validation", () => {
  it("(c) rejects a cmd with a shell metacharacter", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: { path: "repro.js", contents: "process.exit(0)\n" },
      cmd: "node repro.js | tee out.log",
      rationale: null,
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.reproTest).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("cmd_not_allowlisted");
  });

  it("(d) rejects a cmd whose runner is not on the allowlist", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: { path: "Repro.t.sol", contents: "// solidity\n" },
      cmd: "forge test --match-test testRepro",
      rationale: null,
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.reproTest).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("cmd_not_allowlisted");
  });
});

describe("generateReproTest — file validation", () => {
  it("(e) rejects a file.path with a `..` traversal segment", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: { path: "../etc/passwd", contents: "x\n" },
      cmd: "bash ../etc/passwd",
      rationale: null,
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.reproTest).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("unsafe_file_path");
  });

  it("rejects a file.path with a leading slash (absolute)", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: { path: "/tmp/repro.py", contents: "x\n" },
      cmd: "pytest /tmp/repro.py",
      rationale: null,
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.reproTest).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("unsafe_file_path");
  });

  it("(f) rejects oversize file.contents (> cap)", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: { path: "repro.py", contents: "x".repeat(REPRO_FILE_MAX_BYTES + 1) },
      cmd: "pytest repro.py",
      rationale: null,
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.reproTest).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("size_cap");
  });

  it("accepts file.contents exactly at the cap", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: { path: "repro.py", contents: "x".repeat(REPRO_FILE_MAX_BYTES) },
      cmd: "pytest repro.py",
      rationale: null,
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(result.proposals[0]?.reproTest?.file?.contents.length).toBe(REPRO_FILE_MAX_BYTES);
  });
});

describe("generateReproTest — decline", () => {
  it("(g) carries through cmd=null as a clean decline with rationale preserved and no skipReason", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: null,
      cmd: null,
      rationale: "needs a running database to reproduce",
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(result.proposals[0]?.reproTest?.cmd).toBeNull();
    expect(result.proposals[0]?.reproTest?.rationale).toBe("needs a running database to reproduce");
  });

  it("nulls out a non-null file on decline — cannot smuggle an unvalidated file past 2b", async () => {
    const provider = buildProvider("anthropic", async () => ({
      file: { path: "../../etc/cron.d/x", contents: "x".repeat(REPRO_FILE_MAX_BYTES + 1) },
      cmd: null,
      rationale: "declined",
    }));
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.skipReason).toBeNull();
    expect(result.proposals[0]?.reproTest?.cmd).toBeNull();
    // The unsafe/oversize file must NOT survive a decline (path/size unvalidated).
    expect(result.proposals[0]?.reproTest?.file).toBeNull();
  });
});

describe("reproTestOutputSchema — tolerates omitted keys (#134 pattern)", () => {
  it("coerces omitted file/cmd/rationale to null instead of throwing", () => {
    expect(reproTestOutputSchema.parse({ cmd: "pytest x" })).toEqual({
      file: null,
      cmd: "pytest x",
      rationale: null,
    });
    expect(reproTestOutputSchema.parse({})).toEqual({ file: null, cmd: null, rationale: null });
  });
});

describe("generateReproTest — failure isolation", () => {
  it("(h1) emits generation_error when the provider throws", async () => {
    const provider: ReproProposingProvider = {
      name: "anthropic",
      async proposeReproTest() {
        throw new Error("API 500");
      },
    };
    const result = await generateReproTest(baseArgs({ provider }));
    expect(result.proposals[0]?.reproTest).toBeNull();
    expect(result.proposals[0]?.skipReason).toBe("generation_error");
  });

  it("(h2) emits generation_error when the provider exceeds the timeout", async () => {
    const provider: ReproProposingProvider = {
      name: "slow",
      async proposeReproTest() {
        await new Promise((r) => setTimeout(r, 80));
        return { file: null, cmd: "pytest x.py", rationale: null, modelId: "stub-model" };
      },
    };
    const result = await generateReproTest(baseArgs({ provider, timeoutMs: 20 }));
    expect(result.proposals[0]?.skipReason).toBe("generation_error");
  });
});

describe("generateReproTest — precheck", () => {
  it("skips (no_evidence) without calling the provider when the finding has no evidence", async () => {
    let called = false;
    const provider: ReproProposingProvider = {
      name: "anthropic",
      async proposeReproTest() {
        called = true;
        throw new Error("should not reach provider");
      },
    };
    const finding = stubFinding({ evidence: [] });
    const result = await generateReproTest(baseArgs({ findings: [finding], provider }));
    expect(result.proposals[0]?.skipReason).toBe("no_evidence");
    expect(result.proposals[0]?.reproTest).toBeNull();
    expect(called).toBe(false);
  });
});

describe("generateReproTest — fan-out + input validation", () => {
  it("returns one proposal per finding, keyed by findingId", async () => {
    const findings = [stubFinding(), stubFinding({ title: "Second bug" })];
    const result = await generateReproTest(baseArgs({ findings, findingIds: ["a", "b"] }));
    expect(result.proposals.map((p) => p.findingId)).toEqual(["a", "b"]);
  });

  it("throws when findings and findingIds lengths disagree", async () => {
    await expect(
      generateReproTest(
        baseArgs({ findings: [stubFinding(), stubFinding()], findingIds: ["one"] }),
      ),
    ).rejects.toThrow(/align/u);
  });

  it("emits an empty proposal list when no findings are passed", async () => {
    const result = await generateReproTest(baseArgs({ findings: [], findingIds: [] }));
    expect(result.proposals).toEqual([]);
  });
});

describe("isSafeReproPath", () => {
  it("accepts a plain repo-relative path", () => {
    expect(isSafeReproPath("repro_test.py")).toBe(true);
    expect(isSafeReproPath("tests/repro/case.js")).toBe(true);
  });

  it("rejects empty, absolute, traversal, and windows/backslash paths", () => {
    expect(isSafeReproPath("")).toBe(false);
    expect(isSafeReproPath("/etc/passwd")).toBe(false);
    expect(isSafeReproPath("../secret")).toBe(false);
    expect(isSafeReproPath("a/../../b")).toBe(false);
    expect(isSafeReproPath("C:\\repro.py")).toBe(false);
    expect(isSafeReproPath("dir\\file")).toBe(false);
  });
});
