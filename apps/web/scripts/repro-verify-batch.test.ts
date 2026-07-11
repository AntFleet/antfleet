import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PatchVerifyOutcome } from "@/lib/patch-verifier";
import {
  assertNoSecretsInEnv,
  shapeVerdictRecord,
  runExecPhase,
  runRecordPhase,
  summariseVerdicts,
  parseArgs,
  type ReproSpec,
} from "./repro-verify-batch";

// Contained CI repro-execution batch (issue #133, Build 2b-2) — unit tests.
// Mirrors repro-verifier.test.ts: every IO surface is mocked / injected, so no
// real fs, network, db, provider, or subprocess is touched. The verifier itself
// is injected via the runExecPhase seam so nothing is ever spawned.

// A ReproTestSuggestion-shaped stub. Exec never re-validates it (the injected
// verifier does), so a minimal shape is fine for these tests.
function mkSpec(overrides: Partial<ReproSpec> = {}): ReproSpec {
  return {
    reviewId: "rev-1",
    findingId: "abc-0",
    repoUrl: "https://github.com/o/r.git",
    sha: "abc1234",
    patch: "diff --git a/x b/x\n",
    repro: {
      file: { path: "repro_test.py", contents: "assert True\n" },
      cmd: "pytest repro_test.py",
      rationale: null,
      modelId: "claude-opus-test",
    },
    ...overrides,
  };
}

function mkOutcome(overrides: Partial<PatchVerifyOutcome> = {}): PatchVerifyOutcome {
  return {
    verdict: "verified",
    detector: "pnpm",
    testCmd: "pnpm test --offline",
    testExitCode: 0,
    testMs: 5,
    pocCmd: null,
    pocExitCode: null,
    pocMs: null,
    ms: 10,
    notes: "PROVED: repro exited 0 pre-patch and non-zero post-patch",
    worktreePath: "/tmp/antfleet-pv-x",
    error: null,
    inconclusiveReason: null,
    reproCmd: "pytest repro_test.py",
    reproPreExitCode: 0,
    reproPostExitCode: 2,
    reproPreMs: 5,
    reproPostMs: 5,
    ...overrides,
  };
}

// ── assertNoSecretsInEnv: save/restore the real process.env so the guard tests
// never leak state into the rest of the suite.
describe("assertNoSecretsInEnv", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    for (const k of [
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "POSTGRES_URL",
    ]) {
      delete process.env[k];
    }
  });
  afterEach(() => {
    process.env = saved;
  });

  it("throws when DATABASE_URL is set", () => {
    process.env["DATABASE_URL"] = "postgres://secret";
    expect(() => assertNoSecretsInEnv()).toThrow(/DATABASE_URL/);
    expect(() => assertNoSecretsInEnv()).toThrow(/REFUSING to execute/);
  });

  it("throws when ANTHROPIC_API_KEY is set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-xxx";
    expect(() => assertNoSecretsInEnv()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("names EVERY leaked secret in the message", () => {
    process.env["DATABASE_URL"] = "postgres://secret";
    process.env["GITHUB_TOKEN"] = "ghp_xxx";
    expect(() => assertNoSecretsInEnv()).toThrow(/DATABASE_URL/);
    expect(() => assertNoSecretsInEnv()).toThrow(/GITHUB_TOKEN/);
  });

  it("passes when the environment is clean", () => {
    expect(() => assertNoSecretsInEnv()).not.toThrow();
  });

  it("treats an exported-but-empty secret as absent (does not throw)", () => {
    process.env["OPENAI_API_KEY"] = "";
    expect(() => assertNoSecretsInEnv()).not.toThrow();
  });

  it("can be pointed at an explicit env object", () => {
    expect(() => assertNoSecretsInEnv({ POSTGRES_URL: "postgres://x" })).toThrow(/POSTGRES_URL/);
    expect(() => assertNoSecretsInEnv({ SOMETHING_ELSE: "ok" })).not.toThrow();
  });
});

// ── shapeVerdictRecord: pure projection of a verifier outcome.
describe("shapeVerdictRecord", () => {
  it("maps a verified outcome to the record shape", () => {
    const rec = shapeVerdictRecord(mkSpec(), mkOutcome());
    expect(rec).toEqual({
      reviewId: "rev-1",
      findingId: "abc-0",
      verdict: "verified",
      inconclusiveReason: null,
      reproPreExitCode: 0,
      reproPostExitCode: 2,
      notes: "PROVED: repro exited 0 pre-patch and non-zero post-patch",
    });
  });

  it("maps an inconclusive outcome (carrying its reason) to the record shape", () => {
    const rec = shapeVerdictRecord(
      mkSpec({ findingId: "def-3" }),
      mkOutcome({
        verdict: "inconclusive",
        inconclusiveReason: "repro_not_reproducing",
        reproPreExitCode: 1,
        reproPostExitCode: null,
        notes: "repro did NOT exit 0 pre-patch",
      }),
    );
    expect(rec.findingId).toBe("def-3");
    expect(rec.verdict).toBe("inconclusive");
    expect(rec.inconclusiveReason).toBe("repro_not_reproducing");
    expect(rec.reproPreExitCode).toBe(1);
    expect(rec.reproPostExitCode).toBeNull();
  });
});

describe("summariseVerdicts", () => {
  it("counts verified / regressed / inconclusive", () => {
    const counts = summariseVerdicts([
      shapeVerdictRecord(mkSpec(), mkOutcome({ verdict: "verified" })),
      shapeVerdictRecord(mkSpec(), mkOutcome({ verdict: "regressed" })),
      shapeVerdictRecord(mkSpec(), mkOutcome({ verdict: "regressed" })),
      shapeVerdictRecord(mkSpec(), mkOutcome({ verdict: "inconclusive" })),
    ]);
    expect(counts).toEqual({ verified: 1, regressed: 2, inconclusive: 1 });
  });
});

// ── exec phase: runs over an in-memory specs array with an INJECTED verifier so
// nothing is spawned; asserts it produces correct verdict counts.
describe("runExecPhase", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    for (const k of [
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "POSTGRES_URL",
    ]) {
      delete process.env[k];
    }
    delete process.env["ANTFLEET_REPRO_EXEC"];
  });
  afterEach(() => {
    process.env = saved;
  });

  it("runs each spec through the injected verifier and tallies verdicts", async () => {
    const specs = [
      mkSpec({ findingId: "a-0" }),
      mkSpec({ findingId: "b-1" }),
      mkSpec({ findingId: "c-2" }),
    ];
    const seen: string[] = [];
    const runVerifier = vi.fn(async (spec: ReproSpec) => {
      seen.push(spec.findingId);
      if (spec.findingId === "a-0") return mkOutcome({ verdict: "verified" });
      if (spec.findingId === "b-1") return mkOutcome({ verdict: "regressed" });
      return mkOutcome({ verdict: "inconclusive", inconclusiveReason: "no_runner" });
    });
    const writeVerdicts = vi.fn(async () => {});

    const records = await runExecPhase({
      inPath: "unused.json",
      outPath: "unused-out.json",
      loadSpecs: async () => specs,
      runVerifier,
      writeVerdicts,
      log: () => {},
    });

    expect(runVerifier).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(["a-0", "b-1", "c-2"]);
    expect(summariseVerdicts(records)).toEqual({ verified: 1, regressed: 1, inconclusive: 1 });
    expect(writeVerdicts).toHaveBeenCalledOnce();
    // It flips the exec flag on for its own process.
    expect(process.env["ANTFLEET_REPRO_EXEC"]).toBe("true");
  });

  it("fails CLOSED before running anything when a secret is present", async () => {
    process.env["DATABASE_URL"] = "postgres://leaked";
    const runVerifier = vi.fn(async () => mkOutcome());
    await expect(
      runExecPhase({
        inPath: "unused.json",
        outPath: "unused.json",
        loadSpecs: async () => [mkSpec()],
        runVerifier,
        writeVerdicts: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/DATABASE_URL/);
    expect(runVerifier).not.toHaveBeenCalled();
  });

  it("turns a verifier throw into an inconclusive record instead of aborting the batch", async () => {
    const specs = [mkSpec({ findingId: "a-0" }), mkSpec({ findingId: "b-1" })];
    const runVerifier = vi.fn(async (spec: ReproSpec) => {
      if (spec.findingId === "a-0") throw new Error("spawn EACCES");
      return mkOutcome({ verdict: "verified" });
    });
    const records = await runExecPhase({
      inPath: "x",
      outPath: "x",
      loadSpecs: async () => specs,
      runVerifier,
      writeVerdicts: async () => {},
      log: () => {},
    });
    expect(records).toHaveLength(2);
    expect(records[0]?.verdict).toBe("inconclusive");
    expect(records[0]?.inconclusiveReason).toBe("exception");
    expect(records[0]?.notes).toMatch(/spawn EACCES/);
    expect(records[1]?.verdict).toBe("verified");
  });
});

// ── record phase: dry-run must write NOTHING; --record must call the writer.
describe("runRecordPhase", () => {
  const verdicts = [
    shapeVerdictRecord(mkSpec({ reviewId: "rev-1", findingId: "a-0" }), mkOutcome()),
    shapeVerdictRecord(
      mkSpec({ reviewId: "rev-2", findingId: "b-1" }),
      mkOutcome({ verdict: "regressed" }),
    ),
  ];

  it("dry-run (no --record) writes nothing", async () => {
    const writeGateOutcome = vi.fn(async () => {});
    const written = await runRecordPhase({
      inPath: "unused.json",
      record: false,
      loadVerdicts: async () => verdicts,
      writeGateOutcome,
      log: () => {},
    });
    expect(written).toBe(0);
    expect(writeGateOutcome).not.toHaveBeenCalled();
  });

  it("with --record writes one gate-outcome row per verdict", async () => {
    const calls: Array<{ reviewId: string; findingId: string; verdict: string }> = [];
    const writeGateOutcome = vi.fn(
      async (reviewId: string, row: { findingId: string; verdict: string; evidence: unknown }) => {
        calls.push({ reviewId, findingId: row.findingId, verdict: row.verdict });
      },
    );
    const written = await runRecordPhase({
      inPath: "unused.json",
      record: true,
      loadVerdicts: async () => verdicts,
      writeGateOutcome,
      log: () => {},
    });
    expect(written).toBe(2);
    expect(writeGateOutcome).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      { reviewId: "rev-1", findingId: "a-0", verdict: "verified" },
      { reviewId: "rev-2", findingId: "b-1", verdict: "regressed" },
    ]);
  });
});

// ── parseArgs: the tiny flag parser the CLI dispatches on.
describe("parseArgs", () => {
  it("reads --flag value pairs and boolean flags", () => {
    const { get, has } = parseArgs([
      "node",
      "script",
      "--phase",
      "exec",
      "--limit",
      "7",
      "--record",
    ]);
    expect(get("--phase")).toBe("exec");
    expect(get("--limit")).toBe("7");
    expect(has("--record")).toBe(true);
    expect(has("--missing")).toBe(false);
  });

  it("returns null for a flag whose value is another flag or absent", () => {
    const { get } = parseArgs(["node", "script", "--repo", "--phase", "fetch"]);
    // --repo has no value (next token is a flag), so it reads as null.
    expect(get("--repo")).toBeNull();
    expect(get("--out")).toBeNull();
  });
});
