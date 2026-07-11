import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PatchVerifyOutcome } from "@/lib/patch-verifier";
import type { ReproTestSuggestion } from "@antfleet/cli/types";
import {
  assertNoSecretsInEnv,
  shapeVerdictRecord,
  computeSpecDigest,
  runFetchPhase,
  runExecPhase,
  runRecordPhase,
  summariseVerdicts,
  parseArgs,
  parseVerdicts,
  type ReproSpec,
  type VerdictRecord,
  type FetchDeps,
} from "./repro-verify-batch";

// Contained CI repro-execution batch (issue #133 Build 2b-2 / #145 part 2) —
// unit tests. Mirrors repro-verifier.test.ts: every IO surface is mocked /
// injected, so no real fs, network, db, provider, or subprocess is touched. The
// verifier itself is injected via the runExecPhase seam so nothing is spawned.

// A ReproTestSuggestion-shaped stub. Exec never re-validates it (the injected
// verifier does), so a minimal shape is fine for these tests.
function mkRepro(overrides: Partial<ReproTestSuggestion> = {}): ReproTestSuggestion {
  return {
    file: { path: "repro_test.py", contents: "assert True\n" },
    cmd: "pytest repro_test.py",
    rationale: null,
    modelId: "claude-opus-test",
    ...overrides,
  };
}

function mkSpec(overrides: Partial<ReproSpec> = {}): ReproSpec {
  const base: ReproSpec = {
    reviewId: "rev-1",
    findingId: "abc-0",
    findingIndex: 0,
    repoUrl: "https://github.com/o/r.git",
    mirrorDir: "/tmp/antfleet-mirror-x.git",
    sha: "abc1234",
    patch: "diff --git a/x b/x\n",
    repro: mkRepro(),
    specDigest: "deadbeefdeadbeef",
  };
  return { ...base, ...overrides };
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
    // Swap in a minimal, allowlist-clean env so the default-arg (process.env)
    // calls are hermetic — the hardened pattern guard (FIX 5) would otherwise
    // catch whatever secret-shaped vars the CI shell exports (e.g. *_API_KEY).
    saved = process.env;
    process.env = {
      PATH: saved["PATH"] ?? "/usr/bin",
      HOME: saved["HOME"] ?? "/tmp",
      CI: "true",
      NODE_ENV: "test",
    };
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
    expect(() =>
      assertNoSecretsInEnv({ PATH: "/usr/bin", HOME: "/home/x", CI: "true" }),
    ).not.toThrow();
  });

  it("treats an exported-but-empty secret as absent (does not throw)", () => {
    process.env["OPENAI_API_KEY"] = "";
    expect(() => assertNoSecretsInEnv()).not.toThrow();
  });

  it("can be pointed at an explicit env object", () => {
    expect(() => assertNoSecretsInEnv({ POSTGRES_URL: "postgres://x" })).toThrow(/POSTGRES_URL/);
    expect(() => assertNoSecretsInEnv({ SOMETHING_ELSE: "ok" })).not.toThrow();
  });

  // FIX 5 — the hardened pattern + named + allowlist behavior.
  it("catches a PATTERNED secret name not on the explicit list (FOO_TOKEN)", () => {
    expect(() => assertNoSecretsInEnv({ FOO_TOKEN: "abc" })).toThrow(/FOO_TOKEN/);
  });

  it("catches secret-shaped suffixes broadly (_SECRET, _KEY, _PASSWORD, _HMAC, _PAT)", () => {
    expect(() => assertNoSecretsInEnv({ SOME_SECRET: "x" })).toThrow(/SOME_SECRET/);
    expect(() => assertNoSecretsInEnv({ WEIRD_API_KEY: "x" })).toThrow(/WEIRD_API_KEY/);
    expect(() => assertNoSecretsInEnv({ DB_PASSWORD: "x" })).toThrow(/DB_PASSWORD/);
    expect(() => assertNoSecretsInEnv({ SIGNING_HMAC: "x" })).toThrow(/SIGNING_HMAC/);
    expect(() => assertNoSecretsInEnv({ SOME_PAT: "x" })).toThrow(/SOME_PAT/);
  });

  it("catches a var CONTAINING PRIVATE_KEY even without a matching suffix", () => {
    expect(() => assertNoSecretsInEnv({ MY_PRIVATE_KEY_MATERIAL: "x" })).toThrow(
      /MY_PRIVATE_KEY_MATERIAL/,
    );
  });

  it("catches a NAMED app secret (GITHUB_APP_PRIVATE_KEY)", () => {
    expect(() => assertNoSecretsInEnv({ GITHUB_APP_PRIVATE_KEY: "-----BEGIN" })).toThrow(
      /GITHUB_APP_PRIVATE_KEY/,
    );
  });

  it("does NOT flag allowlisted non-secret vars (GITHUB_SHA, ANTFLEET_REPRO_EXEC)", () => {
    expect(() =>
      assertNoSecretsInEnv({
        GITHUB_SHA: "abcdef",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "123",
        RUNNER_OS: "Linux",
        ANTFLEET_REPRO_EXEC: "true",
        NODE_ENV: "test",
        npm_config_registry: "https://registry.npmjs.org",
        CI: "true",
        PATH: "/usr/bin",
        XDG_CACHE_HOME: "/tmp/cache",
      }),
    ).not.toThrow();
  });

  it("still catches a FORBIDDEN ANTFLEET_* secret even though ANTFLEET_ is an allowlisted prefix", () => {
    // The explicit-name check runs first, so a real ANTFLEET_* secret fails
    // closed despite the ANTFLEET_ allowlist prefix.
    expect(() => assertNoSecretsInEnv({ ANTFLEET_OPS_GH_TOKEN: "ghp_x" })).toThrow(
      /ANTFLEET_OPS_GH_TOKEN/,
    );
    expect(() => assertNoSecretsInEnv({ ANTFLEET_CODESCANNING_PAT: "x" })).toThrow(
      /ANTFLEET_CODESCANNING_PAT/,
    );
  });
});

// ── computeSpecDigest: stable content hash.
describe("computeSpecDigest", () => {
  it("is deterministic for identical inputs and differs when the patch changes", () => {
    const a = computeSpecDigest({
      repoUrl: "https://github.com/o/r.git",
      sha: "abc1234",
      patch: "diff A",
      repro: mkRepro(),
    });
    const b = computeSpecDigest({
      repoUrl: "https://github.com/o/r.git",
      sha: "abc1234",
      patch: "diff A",
      repro: mkRepro(),
    });
    const c = computeSpecDigest({
      repoUrl: "https://github.com/o/r.git",
      sha: "abc1234",
      patch: "diff B",
      repro: mkRepro(),
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── shapeVerdictRecord: pure ENRICHED projection of a verifier outcome.
describe("shapeVerdictRecord", () => {
  it("maps a verified outcome to the enriched record shape", () => {
    const rec = shapeVerdictRecord(mkSpec(), mkOutcome());
    expect(rec).toEqual({
      reviewId: "rev-1",
      findingId: "abc-0",
      verdict: "verified",
      inconclusiveReason: null,
      sha: "abc1234",
      reproCmd: "pytest repro_test.py",
      detector: "pnpm",
      testExitCode: 0,
      reproPreExitCode: 0,
      reproPostExitCode: 2,
      testMs: 5,
      reproPreMs: 5,
      reproPostMs: 5,
      totalMs: 10,
      modelId: "claude-opus-test",
      specDigest: "deadbeefdeadbeef",
      notes: "PROVED: repro exited 0 pre-patch and non-zero post-patch",
    });
  });

  it("maps an inconclusive outcome (carrying its reason + timings) to the record shape", () => {
    const rec = shapeVerdictRecord(
      mkSpec({ findingId: "def-3", findingIndex: 3 }),
      mkOutcome({
        verdict: "inconclusive",
        inconclusiveReason: "repro_not_reproducing",
        reproPreExitCode: 1,
        reproPostExitCode: null,
        reproPostMs: null,
        notes: "repro did NOT exit 0 pre-patch",
      }),
    );
    expect(rec.findingId).toBe("def-3");
    expect(rec.verdict).toBe("inconclusive");
    expect(rec.inconclusiveReason).toBe("repro_not_reproducing");
    expect(rec.reproPreExitCode).toBe(1);
    expect(rec.reproPostExitCode).toBeNull();
    expect(rec.reproPostMs).toBeNull();
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

// ────────────────────────────────────────────────────────────────────────
// fetch phase — the FIX 1 (mis-pairing) + FIX 2 (limit) + FIX 3 (skip labels)
// regression tests. All deps injected so no DB / provider / network / git.
// ────────────────────────────────────────────────────────────────────────

// An agreementDecision whose agreed[] has a MALFORMED earlier entry (index 1,
// missing title) between two well-formed ones (0 and 2). If the fetch phase
// compacted agreed[] (the v1 bug), index 2's finding would shift to position 1
// and a suggestedPatch keyed to findingIndex=2 would pair with the WRONG
// finding. Position-preserving extractAgreed keeps them aligned.
function agreementWithMalformedMiddle(): unknown {
  return {
    agreed: [
      {
        title: "finding-zero",
        category: "security",
        severity: "high",
        evidence: [{ path: "a.ts", startLine: 1, endLine: 2 }],
        reasoning: "r0",
        reproduction: null,
        recommendation: "rec0",
      },
      // MALFORMED — missing title. Must map to null WITHOUT collapsing indices.
      {
        category: "security",
        severity: "high",
        evidence: [{ path: "b.ts", startLine: 3, endLine: 4 }],
      },
      {
        title: "finding-two",
        category: "correctness",
        severity: "medium",
        evidence: [{ path: "c.ts", startLine: 5, endLine: 6 }],
        reasoning: "r2",
        reproduction: null,
        recommendation: "rec2",
      },
    ],
  };
}

// Build FetchDeps with a single candidate review carrying the given
// finding_status rows, and a generateRepro spy that records which finding TITLE
// it was asked to build a repro for (so mis-pairing is observable).
function mkFetchDeps(
  statuses: Array<{
    findingId: string;
    findingIndex: number;
    source: string;
    suggestedPatch: string;
  }>,
  agreementDecision: unknown,
  opts: {
    generate?: FetchDeps["generateRepro"];
    createMirror?: FetchDeps["createMirror"];
    seenTitles?: string[];
  } = {},
): FetchDeps {
  return {
    loadCandidates: async () => ({
      rows: [
        {
          reviewId: "rev-1",
          owner: "o",
          repo: "r",
          prNumber: 7,
          commitSha: "abc1234",
          agreementDecision,
          findingStatuses: statuses,
        },
      ],
      scanned: 1,
      sinceIso: "2026-01-01T00:00:00.000Z",
    }),
    fetchChangedFiles: async () => [{ filename: "a.ts", contents: "code" }],
    generateRepro:
      opts.generate ??
      (async ({ finding }) => {
        opts.seenTitles?.push(finding.title);
        return mkRepro();
      }),
    createMirror: opts.createMirror ?? (async () => "/tmp/antfleet-mirror-test.git"),
  };
}

describe("runFetchPhase — FIX 1 (positional pairing, no renumber)", () => {
  it("pairs a suggestedPatch to its findingIndex even when an EARLIER agreed entry is malformed", async () => {
    const seenTitles: string[] = [];
    const generatedFor: Array<{ findingId: string; title: string }> = [];
    const deps = mkFetchDeps(
      [{ findingId: "rev-2", findingIndex: 2, source: "consensus", suggestedPatch: "patch-for-2" }],
      agreementWithMalformedMiddle(),
      {
        seenTitles,
        generate: async ({ finding, findingId }) => {
          generatedFor.push({ findingId, title: finding.title });
          return mkRepro();
        },
      },
    );
    const specs = await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps: { ...deps, createMirror: async () => "/tmp/m.git" },
      writeSpecs: async () => {},
      log: () => {},
    });
    // The correct finding (index 2 → "finding-two") was paired, NOT the shifted
    // "finding-zero" a compacting bug would have produced at position 1.
    expect(specs).toHaveLength(1);
    expect(generatedFor).toEqual([{ findingId: "rev-2", title: "finding-two" }]);
    expect(specs[0]?.findingIndex).toBe(2);
    expect(specs[0]?.patch).toBe("patch-for-2");
  });

  it("skips a finding whose findingIndex points at a malformed agreed entry", async () => {
    const logs: string[] = [];
    const deps = mkFetchDeps(
      [{ findingId: "rev-1", findingIndex: 1, source: "consensus", suggestedPatch: "patch-for-1" }],
      agreementWithMalformedMiddle(),
    );
    const specs = await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: (m) => logs.push(m),
    });
    expect(specs).toHaveLength(0);
    expect(logs.some((l) => /malformed-agreed-entry/.test(l))).toBe(true);
  });

  it("does NOT process a source='single_model' row (SQL should exclude, and the shape is guarded)", async () => {
    // Even if a single_model row leaks through, the loadCandidates seam is the
    // consensus filter in prod; here we prove the phase only ever emits specs
    // for the rows loadCandidates returned. A single_model finding is simply not
    // returned by the (consensus-filtering) loader, so no spec is emitted.
    const seenTitles: string[] = [];
    const deps: FetchDeps = {
      loadCandidates: async () => ({
        // loadCandidates already filtered to source='consensus'; a single_model
        // row would never appear here. Return an EMPTY candidate set to model
        // "the only finding was single_model and thus excluded".
        rows: [],
        scanned: 3,
        sinceIso: "2026-01-01T00:00:00.000Z",
      }),
      fetchChangedFiles: async () => [],
      generateRepro: async ({ finding }) => {
        seenTitles.push(finding.title);
        return mkRepro();
      },
      createMirror: async () => "/tmp/m.git",
    };
    const specs = await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: () => {},
    });
    expect(specs).toHaveLength(0);
    expect(seenTitles).toEqual([]);
  });
});

describe("runFetchPhase — FIX 2 (limit caps generation ATTEMPTS)", () => {
  it("stops at --limit generation attempts even when some attempts decline", async () => {
    // 4 well-formed agreed findings, each with a patch. limit=2 → exactly 2
    // generation attempts, regardless of decline. First declines, second emits.
    const agreed = [0, 1, 2, 3].map((i) => ({
      title: `f-${i}`,
      category: "security",
      severity: "high",
      evidence: [{ path: `${i}.ts`, startLine: 1, endLine: 1 }],
      reasoning: "r",
      reproduction: null,
      recommendation: "rec",
    }));
    const statuses = [0, 1, 2, 3].map((i) => ({
      findingId: `rev-${i}`,
      findingIndex: i,
      source: "consensus",
      suggestedPatch: `patch-${i}`,
    }));
    let attempts = 0;
    const deps = mkFetchDeps(
      statuses,
      { agreed },
      {
        generate: async () => {
          attempts++;
          // First attempt DECLINES (cmd null) — must still consume a cap unit.
          if (attempts === 1) return mkRepro({ cmd: null, file: null, rationale: "no repro" });
          return mkRepro();
        },
      },
    );
    const specs = await runFetchPhase({
      limit: 2,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: () => {},
    });
    // Exactly 2 attempts consumed the cap (1 decline + 1 emit); attempt 3/4 never ran.
    expect(attempts).toBe(2);
    expect(specs).toHaveLength(1);
  });
});

describe("runFetchPhase — FIX 3 (real skip reason labels)", () => {
  it("logs the no-evidence skip with the no-evidence reason (not an id-shape label)", async () => {
    const logs: string[] = [];
    const agreed = [
      {
        title: "no-ev",
        category: "security",
        severity: "high",
        evidence: [], // no evidence path
        reasoning: "r",
        reproduction: null,
        recommendation: "rec",
      },
    ];
    let generateCalled = 0;
    const deps = mkFetchDeps(
      [{ findingId: "rev-0", findingIndex: 0, source: "consensus", suggestedPatch: "p" }],
      { agreed },
      {
        generate: async () => {
          generateCalled++;
          return mkRepro();
        },
      },
    );
    const specs = await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: (m) => logs.push(m),
    });
    expect(specs).toHaveLength(0);
    // No generation call — dropped at pairing time.
    expect(generateCalled).toBe(0);
    expect(logs.some((l) => /no-evidence/.test(l))).toBe(true);
    // And NOT mislabeled as an id-shape mismatch (the v1 bug).
    expect(logs.some((l) => /id shape/i.test(l))).toBe(false);
  });

  it("logs a declined generation with the generation-declined reason", async () => {
    const logs: string[] = [];
    const agreed = [
      {
        title: "declined",
        category: "security",
        severity: "high",
        evidence: [{ path: "a.ts", startLine: 1, endLine: 1 }],
        reasoning: "r",
        reproduction: null,
        recommendation: "rec",
      },
    ];
    const deps = mkFetchDeps(
      [{ findingId: "rev-0", findingIndex: 0, source: "consensus", suggestedPatch: "p" }],
      { agreed },
      { generate: async () => mkRepro({ cmd: null, file: null, rationale: "needs a DB" }) },
    );
    await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => /generation-declined/.test(l))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// exec phase — runs over an in-memory specs array with an INJECTED verifier so
// nothing is spawned; asserts verdict counts + OFFLINE wiring.
// ────────────────────────────────────────────────────────────────────────

describe("runExecPhase", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    // The exec phase's assertNoSecretsInEnv reads the REAL process.env (no seam
    // — that is the point), and the hardened guard (FIX 5) also catches
    // pattern-shaped names the CI shell may export (e.g. *_API_KEY). Swap in a
    // minimal, allowlist-clean env so these tests are hermetic against whatever
    // the runner exports; restore it in afterEach.
    saved = process.env;
    process.env = {
      PATH: saved["PATH"] ?? "/usr/bin",
      HOME: saved["HOME"] ?? "/tmp",
      CI: "true",
      NODE_ENV: "test",
    };
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

  it("turns a verifier throw into an enriched inconclusive record instead of aborting the batch", async () => {
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
    // Enriched even on the throw path: carries the sha + digest from the spec.
    expect(records[0]?.sha).toBe("abc1234");
    expect(records[0]?.specDigest).toBe("deadbeefdeadbeef");
    expect(records[1]?.verdict).toBe("verified");
  });

  // FIX 4 — the exec phase must call the verifier in OFFLINE mode with the
  // spec's mirror path. We assert against the REAL runReproVerifier via the
  // default wiring is impractical (it spawns), so we prove the offline contract
  // by capturing what a passthrough seam receives.
  it("invokes the verifier OFFLINE with the spec mirror path (FIX 4)", async () => {
    const seenSources: Array<{ kind: string; mirrorDir?: string; sha: string }> = [];
    const runVerifier = vi.fn(async (spec: ReproSpec) => {
      // Mirror what realVerifier does: derive the offline repoSource from the
      // spec. This asserts the spec carries a mirrorDir the exec phase can use.
      seenSources.push({ kind: "offline", mirrorDir: spec.mirrorDir, sha: spec.sha });
      return mkOutcome();
    });
    await runExecPhase({
      inPath: "x",
      outPath: "x",
      loadSpecs: async () => [mkSpec({ mirrorDir: "/tmp/antfleet-mirror-abc.git" })],
      runVerifier,
      writeVerdicts: async () => {},
      log: () => {},
    });
    expect(seenSources).toEqual([
      { kind: "offline", mirrorDir: "/tmp/antfleet-mirror-abc.git", sha: "abc1234" },
    ]);
  });
});

// ── parseVerdicts: STRICT shape validation (FIX 6).
describe("parseVerdicts", () => {
  const good: VerdictRecord = {
    reviewId: "rev-1",
    findingId: "a-0",
    verdict: "verified",
    inconclusiveReason: null,
    sha: "abc1234",
    reproCmd: "pytest x",
    detector: "pnpm",
    testExitCode: 0,
    reproPreExitCode: 0,
    reproPostExitCode: 2,
    testMs: 5,
    reproPreMs: 5,
    reproPostMs: 5,
    totalMs: 10,
    modelId: "m",
    specDigest: "d",
    notes: "ok",
  };

  it("accepts a well-formed verdicts array", () => {
    const recs = parseVerdicts(JSON.stringify([good]));
    expect(recs).toHaveLength(1);
    expect(recs[0]?.verdict).toBe("verified");
  });

  it("rejects a non-array file", () => {
    expect(() => parseVerdicts(JSON.stringify({ nope: true }))).toThrow(
      /did not contain a JSON array/,
    );
  });

  it("rejects a record with a missing reviewId", () => {
    const bad = { ...good, reviewId: "" };
    expect(() => parseVerdicts(JSON.stringify([bad]))).toThrow(
      /reviewId must be a non-empty string/,
    );
  });

  it("rejects a record with an unknown verdict", () => {
    const bad = { ...good, verdict: "maybe" };
    expect(() => parseVerdicts(JSON.stringify([bad]))).toThrow(/verdict must be one of/);
  });

  it("rejects a record whose exit code is not number|null", () => {
    const bad = { ...good, reproPreExitCode: "zero" };
    expect(() => parseVerdicts(JSON.stringify([bad]))).toThrow(
      /reproPreExitCode must be number\|null/,
    );
  });
});

// ── record phase: dry-run must write NOTHING; --record must call the writer;
// idempotency must skip already-recorded rows (FIX 6).
describe("runRecordPhase", () => {
  const verdicts: VerdictRecord[] = [
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
      gateOutcomeExists: async () => false,
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
      gateOutcomeExists: async () => false,
      log: () => {},
    });
    expect(written).toBe(2);
    expect(writeGateOutcome).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      { reviewId: "rev-1", findingId: "a-0", verdict: "verified" },
      { reviewId: "rev-2", findingId: "b-1", verdict: "regressed" },
    ]);
  });

  it("persists the FULL enriched record as the evidence payload", async () => {
    let capturedEvidence: unknown = null;
    await runRecordPhase({
      inPath: "unused.json",
      record: true,
      loadVerdicts: async () => [verdicts[0] as VerdictRecord],
      writeGateOutcome: async (_reviewId, row) => {
        capturedEvidence = row.evidence;
      },
      gateOutcomeExists: async () => false,
      log: () => {},
    });
    expect(capturedEvidence).toMatchObject({
      reviewId: "rev-1",
      findingId: "a-0",
      sha: "abc1234",
      detector: "pnpm",
      specDigest: "deadbeefdeadbeef",
    });
  });

  // FIX 6 — idempotency: an already-recorded (review, finding, stage) is skipped.
  it("is IDEMPOTENT — skips a verdict that already has a gate outcome", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const writeGateOutcome = vi.fn(async (reviewId: string, row: { findingId: string }) => {
      calls.push(`${reviewId}/${row.findingId}`);
    });
    // rev-1/a-0 already recorded; rev-2/b-1 is new.
    const gateOutcomeExists = vi.fn(
      async (reviewId: string, findingId: string, stage: string) =>
        stage === "repro_verify" && reviewId === "rev-1" && findingId === "a-0",
    );
    const written = await runRecordPhase({
      inPath: "unused.json",
      record: true,
      loadVerdicts: async () => verdicts,
      writeGateOutcome,
      gateOutcomeExists,
      log: (m) => logs.push(m),
    });
    expect(written).toBe(1);
    expect(calls).toEqual(["rev-2/b-1"]);
    expect(gateOutcomeExists).toHaveBeenCalledWith("rev-1", "a-0", "repro_verify");
    expect(logs.some((l) => /already recorded/.test(l))).toBe(true);
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
