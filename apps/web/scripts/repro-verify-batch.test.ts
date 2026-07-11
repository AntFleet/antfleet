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
  parseSpecs,
  parseVerdicts,
  isOwnedMirrorDir,
  realRemoveMirror,
  pinReproMirror,
  type ReproSpec,
  type VerdictRecord,
  type FetchDeps,
  type GitRun,
} from "./repro-verify-batch";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── assertNoSecretsInEnv: ALLOWLIST-ONLY guard (FIX A). save/restore the real
// process.env so the guard tests never leak state into the rest of the suite.
// A clean allowlisted env swapped in so the default-arg (process.env) calls are
// hermetic against whatever the CI shell exports.
describe("assertNoSecretsInEnv (allowlist-only, FIX A)", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
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

  it("throws when GITHUB_TOKEN is set (a credential, NOT an allowlisted GITHUB_* metadata name)", () => {
    process.env["GITHUB_TOKEN"] = "ghp_xxx";
    expect(() => assertNoSecretsInEnv()).toThrow(/GITHUB_TOKEN/);
  });

  it("names EVERY disallowed var in the message", () => {
    expect(() =>
      assertNoSecretsInEnv({
        PATH: "/usr/bin",
        DATABASE_URL: "postgres://secret",
        GITHUB_TOKEN: "ghp_xxx",
      }),
    ).toThrow(/DATABASE_URL/);
    expect(() =>
      assertNoSecretsInEnv({
        PATH: "/usr/bin",
        DATABASE_URL: "postgres://secret",
        GITHUB_TOKEN: "ghp_xxx",
      }),
    ).toThrow(/GITHUB_TOKEN/);
  });

  it("treats an exported-but-empty disallowed var as absent (does not throw)", () => {
    process.env["OPENAI_API_KEY"] = "";
    expect(() => assertNoSecretsInEnv()).not.toThrow();
  });

  // The leaky-bypass cases the audit called out — all must now be REJECTED
  // because the guard is allowlist-only (default deny), not suffix-pattern.
  it("REJECTS the audit-named prefix-bypass secrets (NODE_AUTH_TOKEN, npm_config_authToken, ANTFLEET_ALERT_WEBHOOK_URL)", () => {
    expect(() => assertNoSecretsInEnv({ PATH: "/usr/bin", NODE_AUTH_TOKEN: "x" })).toThrow(
      /NODE_AUTH_TOKEN/,
    );
    expect(() => assertNoSecretsInEnv({ PATH: "/usr/bin", npm_config_authToken: "x" })).toThrow(
      /npm_config_authToken/,
    );
    expect(() =>
      assertNoSecretsInEnv({ PATH: "/usr/bin", ANTFLEET_ALERT_WEBHOOK_URL: "https://x" }),
    ).toThrow(/ANTFLEET_ALERT_WEBHOOK_URL/);
  });

  it("REJECTS an arbitrary FOO_TOKEN and a FUTURE ANTFLEET_NEW_SECRET (default-deny catches unknown names)", () => {
    expect(() => assertNoSecretsInEnv({ PATH: "/usr/bin", FOO_TOKEN: "abc" })).toThrow(/FOO_TOKEN/);
    expect(() => assertNoSecretsInEnv({ PATH: "/usr/bin", ANTFLEET_NEW_SECRET: "x" })).toThrow(
      /ANTFLEET_NEW_SECRET/,
    );
  });

  it("REJECTS a suffix-shaped RUNNER_ADMIN_SECRET and a non-suffixed ROAST_IP_SALT (no RUNNER_ wildcard)", () => {
    expect(() => assertNoSecretsInEnv({ PATH: "/usr/bin", RUNNER_ADMIN_SECRET: "x" })).toThrow(
      /RUNNER_ADMIN_SECRET/,
    );
    expect(() => assertNoSecretsInEnv({ PATH: "/usr/bin", ROAST_IP_SALT: "x" })).toThrow(
      /ROAST_IP_SALT/,
    );
  });

  it("PASSES the enumerated non-secret vars (PATH, GITHUB_SHA, ANTFLEET_REPRO_EXEC, RUNNER_OS)", () => {
    expect(() =>
      assertNoSecretsInEnv({
        PATH: "/usr/bin",
        GITHUB_SHA: "abcdef",
        ANTFLEET_REPRO_EXEC: "true",
        RUNNER_OS: "Linux",
      }),
    ).not.toThrow();
  });

  it("PASSES a fully allowlisted clean env (positive case)", () => {
    expect(() =>
      assertNoSecretsInEnv({
        PATH: "/usr/bin",
        HOME: "/home/x",
        CI: "true",
        NODE_ENV: "test",
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "123",
        GITHUB_SERVER_URL: "https://github.com",
        RUNNER_OS: "Linux",
        RUNNER_ARCH: "X64",
        RUNNER_TEMP: "/tmp/runner",
        ANTFLEET_REPRO_EXEC: "true",
        ANTFLEET_REPRO_SANDBOX: "1",
        TZ: "UTC",
        TMPDIR: "/tmp",
      }),
    ).not.toThrow();
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
      truncated: false,
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
        truncated: false,
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
    const logs: string[] = [];
    const specs = await runFetchPhase({
      limit: 2,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: (m) => logs.push(m),
    });
    // Exactly 2 attempts consumed the cap (1 decline + 1 emit); attempt 3/4 never ran.
    expect(attempts).toBe(2);
    expect(specs).toHaveLength(1);
    // FIX F: --limit exhausted with 2 eligible findings still unprocessed → logged.
    expect(
      logs.some((l) =>
        /--limit \(2\) reached with 2 eligible finding\(s\) still unprocessed/.test(l),
      ),
    ).toBe(true);
  });
});

describe("runFetchPhase — FIX F (no silent truncation)", () => {
  it("logs a TRUNCATED warning when loadCandidates reports truncated:true", async () => {
    const logs: string[] = [];
    const deps: FetchDeps = {
      loadCandidates: async () => ({
        rows: [
          {
            reviewId: "rev-1",
            owner: "o",
            repo: "r",
            prNumber: 7,
            commitSha: "abc1234",
            agreementDecision: {
              agreed: [
                {
                  title: "f",
                  category: "security",
                  severity: "high",
                  evidence: [{ path: "a.ts", startLine: 1, endLine: 1 }],
                  reasoning: "r",
                  reproduction: null,
                  recommendation: "rec",
                },
              ],
            },
            findingStatuses: [
              { findingId: "rev-0", findingIndex: 0, source: "consensus", suggestedPatch: "p" },
            ],
          },
        ],
        scanned: 1,
        truncated: true,
        sinceIso: "2026-01-01T00:00:00.000Z",
      }),
      fetchChangedFiles: async () => [{ filename: "a.ts", contents: "code" }],
      generateRepro: async () => mkRepro(),
      createMirror: async () => "/tmp/m.git",
    };
    await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => /TRUNCATED/.test(l))).toBe(true);
  });

  it("does NOT log truncation when truncated:false", async () => {
    const logs: string[] = [];
    const deps = mkFetchDeps(
      [{ findingId: "rev-0", findingIndex: 0, source: "consensus", suggestedPatch: "p" }],
      {
        agreed: [
          {
            title: "f",
            category: "security",
            severity: "high",
            evidence: [{ path: "a.ts", startLine: 1, endLine: 1 }],
            reasoning: "r",
            reproduction: null,
            recommendation: "rec",
          },
        ],
      },
    );
    await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: (m) => logs.push(m),
    });
    expect(logs.some((l) => /TRUNCATED/.test(l))).toBe(false);
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

describe("runFetchPhase — FIX C (evidence effective-path)", () => {
  it("skips a finding whose only evidence entry has no real path (evidence:[{}])", async () => {
    const logs: string[] = [];
    // A single agreed finding whose evidence is [{}] — a malformed entry with no
    // path. extractAgreed drops empty-path entries, so this lands as no-evidence
    // at pairing time (NOT a spuriously non-empty [{path:""}]).
    const agreed = [
      {
        title: "empty-ev",
        category: "security",
        severity: "high",
        evidence: [{}],
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
    // Skipped as no-evidence — no spec generated, no model call.
    expect(specs).toHaveLength(0);
    expect(generateCalled).toBe(0);
    expect(logs.some((l) => /no-evidence/.test(l))).toBe(true);
  });

  it("keeps a finding that has a REAL evidence path alongside an empty one", async () => {
    const seen: Array<{ path: string; startLine: number | null; endLine: number | null }[]> = [];
    const agreed = [
      {
        title: "mixed-ev",
        category: "security",
        severity: "high",
        // one empty entry + one real path — the real one keeps the finding alive.
        evidence: [{}, { path: "real.ts", startLine: 3, endLine: 4 }],
        reasoning: "r",
        reproduction: null,
        recommendation: "rec",
      },
    ];
    const deps = mkFetchDeps(
      [{ findingId: "rev-0", findingIndex: 0, source: "consensus", suggestedPatch: "p" }],
      { agreed },
      {
        generate: async ({ finding }) => {
          seen.push(
            finding.evidence.map((e) => ({
              path: e.path,
              startLine: e.startLine,
              endLine: e.endLine,
            })),
          );
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
      log: () => {},
    });
    expect(specs).toHaveLength(1);
    // Only the real-path evidence reached the reconstructed finding (empty dropped).
    expect(seen).toEqual([[{ path: "real.ts", startLine: 3, endLine: 4 }]]);
  });

  // FIX 6b — a whitespace-only path ("   ") is NOT a usable anchor and must be
  // dropped by the effective-path filter (path.trim().length > 0), so a finding
  // whose only evidence path is whitespace lands as no-evidence.
  it("drops a whitespace-only evidence path and skips the finding as no-evidence (FIX 6b)", async () => {
    const logs: string[] = [];
    const agreed = [
      {
        title: "ws-ev",
        category: "security",
        severity: "high",
        evidence: [{ path: "   ", startLine: 1, endLine: 1 }],
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
    expect(generateCalled).toBe(0);
    expect(logs.some((l) => /no-evidence/.test(l))).toBe(true);
  });
});

describe("runFetchPhase — FIX D (threads prNumber into createMirror)", () => {
  it("passes the review's prNumber to createMirror", async () => {
    const mirrorCalls: Array<{ repoUrl: string; sha: string; prNumber: number }> = [];
    const agreed = [
      {
        title: "f",
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
      {
        createMirror: async (repoUrl, sha, prNumber) => {
          mirrorCalls.push({ repoUrl, sha, prNumber });
          return "/tmp/antfleet-mirror-d.git";
        },
      },
    );
    const specs = await runFetchPhase({
      limit: 5,
      repo: null,
      outPath: "unused.json",
      deps,
      writeSpecs: async () => {},
      log: () => {},
    });
    expect(specs).toHaveLength(1);
    // mkFetchDeps builds the single candidate review with prNumber 7.
    expect(mirrorCalls).toEqual([
      { repoUrl: "https://github.com/o/r.git", sha: "abc1234", prNumber: 7 },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// exec phase — runs over an in-memory specs array with an INJECTED verifier so
// nothing is spawned; asserts verdict counts + OFFLINE wiring.
// ────────────────────────────────────────────────────────────────────────

describe("runExecPhase", () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    // The exec phase's assertNoSecretsInEnv AND the FIX H sandbox guard both read
    // the REAL process.env (no seam — that is the point; FIX 5 deleted the
    // injectable sandboxMarker override), and the allowlist-only guard (FIX A)
    // rejects ANY var not enumerated. Swap in a minimal, allowlisted-clean env so
    // these tests are hermetic against whatever the runner exports; restore it in
    // afterEach (exactly like the assertNoSecretsInEnv suite). The
    // ANTFLEET_REPRO_SANDBOX marker is set here so the FIX H sandbox guard passes
    // by default (it is on the allowlist); the dedicated FIX H test clears the
    // REAL var to prove exec refuses.
    saved = process.env;
    process.env = {
      PATH: saved["PATH"] ?? "/usr/bin",
      HOME: saved["HOME"] ?? "/tmp",
      CI: "true",
      NODE_ENV: "test",
      ANTFLEET_REPRO_SANDBOX: "1",
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
    let flagDuringRun: string | undefined;
    const runVerifier = vi.fn(async (spec: ReproSpec) => {
      // The exec flag is ON while the verifier runs (captured here) — but it is
      // RESTORED after runExecPhase returns (FIX I), so we can't assert it on the
      // env post-call.
      flagDuringRun = process.env["ANTFLEET_REPRO_EXEC"];
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
      removeMirror: async () => {},
      log: () => {},
    });

    expect(runVerifier).toHaveBeenCalledTimes(3);
    expect(seen).toEqual(["a-0", "b-1", "c-2"]);
    expect(summariseVerdicts(records)).toEqual({ verified: 1, regressed: 1, inconclusive: 1 });
    expect(writeVerdicts).toHaveBeenCalledOnce();
    // It flips the exec flag on for its own process WHILE running…
    expect(flagDuringRun).toBe("true");
    // …and RESTORES it afterward (was unset in this test's clean env) (FIX I).
    expect(process.env["ANTFLEET_REPRO_EXEC"]).toBeUndefined();
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
        removeMirror: async () => {},
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
      removeMirror: async () => {},
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
      removeMirror: async () => {},
      log: () => {},
    });
    expect(seenSources).toEqual([
      { kind: "offline", mirrorDir: "/tmp/antfleet-mirror-abc.git", sha: "abc1234" },
    ]);
  });

  // FIX H — the exec phase refuses to run outside the sandbox: it requires the
  // ANTFLEET_REPRO_SANDBOX marker (set only by the trusted Part-3 container step).
  it("REFUSES to run when the ANTFLEET_REPRO_SANDBOX marker is absent (FIX H)", async () => {
    delete process.env["ANTFLEET_REPRO_SANDBOX"];
    const runVerifier = vi.fn(async () => mkOutcome());
    await expect(
      runExecPhase({
        inPath: "x",
        outPath: "x",
        loadSpecs: async () => [mkSpec()],
        runVerifier,
        writeVerdicts: async () => {},
        removeMirror: async () => {},
        log: () => {},
      }),
    ).rejects.toThrow(/ANTFLEET_REPRO_SANDBOX is not set/);
    // Refused BEFORE running any model code.
    expect(runVerifier).not.toHaveBeenCalled();
  });

  it("PROCEEDS when the ANTFLEET_REPRO_SANDBOX marker is present in the REAL env (FIX H / FIX 5)", async () => {
    // beforeEach already set the REAL process.env marker; assert the happy path
    // runs. FIX 5 removed the injectable sandboxMarker seam, so the guard reads
    // process.env directly and this is the ONLY way to make it pass.
    const runVerifier = vi.fn(async () => mkOutcome({ verdict: "verified" }));
    const records = await runExecPhase({
      inPath: "x",
      outPath: "x",
      loadSpecs: async () => [mkSpec()],
      runVerifier,
      writeVerdicts: async () => {},
      removeMirror: async () => {},
      log: () => {},
    });
    expect(runVerifier).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
  });

  // FIX E — each spec's disposable mirror is removed after its verifier runs.
  it("removes each spec's mirror dir after exec (FIX E)", async () => {
    const removed: string[] = [];
    const runVerifier = vi.fn(async () => mkOutcome());
    const removeMirror = vi.fn(async (dir: string) => {
      removed.push(dir);
    });
    await runExecPhase({
      inPath: "x",
      outPath: "x",
      loadSpecs: async () => [
        mkSpec({ findingId: "a-0", mirrorDir: "/tmp/antfleet-mirror-a.git" }),
        mkSpec({ findingId: "b-1", mirrorDir: "/tmp/antfleet-mirror-b.git" }),
      ],
      runVerifier,
      writeVerdicts: async () => {},
      removeMirror,
      log: () => {},
    });
    expect(removed).toEqual(["/tmp/antfleet-mirror-a.git", "/tmp/antfleet-mirror-b.git"]);
  });

  it("removes a spec's mirror even when its verifier throws (FIX E — finally)", async () => {
    const removed: string[] = [];
    const runVerifier = vi.fn(async () => {
      throw new Error("spawn EACCES");
    });
    const removeMirror = vi.fn(async (dir: string) => {
      removed.push(dir);
    });
    await runExecPhase({
      inPath: "x",
      outPath: "x",
      loadSpecs: async () => [mkSpec({ mirrorDir: "/tmp/antfleet-mirror-x.git" })],
      runVerifier,
      writeVerdicts: async () => {},
      removeMirror,
      log: () => {},
    });
    expect(removed).toEqual(["/tmp/antfleet-mirror-x.git"]);
  });
});

// ── isOwnedMirrorDir + realRemoveMirror: STRICT ownership gate for the DELETE
// path (FIX 2). The teardown must only ever rm a dir WE created (parent ===
// os.tmpdir() AND basename matches the exact antfleet-mirror-<...> mkdtemp
// prefix), and must REFUSE `/`, `/tmp`, `/home/runner/work`, a `..` traversal,
// and a non-matching basename — the shape-only isSafeLocalMirrorDir is NOT used
// for deletion.
describe("isOwnedMirrorDir (FIX 2)", () => {
  it("accepts a dir directly under os.tmpdir() with the antfleet-mirror- prefix", () => {
    expect(isOwnedMirrorDir(join(tmpdir(), "antfleet-mirror-abc123-XYZ98"))).toBe(true);
    // A realistic mkdtemp basename: antfleet-mirror-<uuid>-<6 chars>.
    expect(isOwnedMirrorDir(join(tmpdir(), "antfleet-mirror-1e4b2c9a-0f11-4a-3d-ab12cd"))).toBe(
      true,
    );
  });

  it("REFUSES `/`, `/tmp`, and `/home/runner/work` (isSafeLocalMirrorDir would allow these)", () => {
    expect(isOwnedMirrorDir("/")).toBe(false);
    expect(isOwnedMirrorDir("/tmp")).toBe(false);
    expect(isOwnedMirrorDir("/home/runner/work")).toBe(false);
  });

  it("REFUSES a `..` traversal that escapes tmpdir (/tmp/antfleet-mirror-x/../../etc)", () => {
    expect(isOwnedMirrorDir("/tmp/antfleet-mirror-x/../../etc")).toBe(false);
  });

  it("REFUSES a dir under tmpdir whose basename does NOT match the prefix", () => {
    expect(isOwnedMirrorDir(join(tmpdir(), "not-a-mirror-xyz"))).toBe(false);
    expect(isOwnedMirrorDir(join(tmpdir(), "antfleet-mirror"))).toBe(false); // prefix, no suffix
    // Right prefix but a slash in the tail → NOT directly under tmpdir.
    expect(isOwnedMirrorDir(join(tmpdir(), "antfleet-mirror-x", "child"))).toBe(false);
  });

  it("REFUSES an empty / non-string input", () => {
    expect(isOwnedMirrorDir("")).toBe(false);
    // @ts-expect-error — guarding the runtime path against a non-string.
    expect(isOwnedMirrorDir(undefined)).toBe(false);
  });
});

describe("realRemoveMirror (FIX 2 — teardown obeys ownership gate)", () => {
  it("DELETES an owned mirror dir under os.tmpdir()", async () => {
    // Create a real owned mirror dir (same prefix realCreateMirror uses) and a
    // child file, then prove teardown removes it.
    const dir = await mkdtemp(join(tmpdir(), "antfleet-mirror-test-"));
    await mkdir(join(dir, "objects"), { recursive: true });
    await realRemoveMirror(dir);
    await expect(stat(dir)).rejects.toThrow(); // gone
  });

  it("REFUSES to delete a non-owned dir (leaves it intact)", async () => {
    // A real dir that is NOT under the antfleet-mirror- prefix — teardown must
    // skip it (warn) and leave it on disk.
    const dir = await mkdtemp(join(tmpdir(), "totally-unrelated-"));
    try {
      await realRemoveMirror(dir);
      // Still there — the ownership gate refused.
      const s = await stat(dir);
      expect(s.isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── pinReproMirror: the PR-pin VERIFY step (FIX 1). The rev-parse MUST resolve
// the ref to its COMMIT SHA (`--verify <ref>^{commit}`), not print the literal
// ref text; a mismatch must fail the spec with a clear reason. Uses an injected
// GitRun so nothing spawns.
describe("pinReproMirror (FIX 1 — PR pin resolves to the commit SHA)", () => {
  const dir = "/tmp/antfleet-mirror-abc.git";
  const sha = "abc1234def5678";

  it("verifies with `rev-parse --verify refs/pinned/<sha>^{commit}` (exact argv) and passes on match", async () => {
    const calls: Array<readonly string[]> = [];
    const run: GitRun = async (file, args) => {
      expect(file).toBe("git");
      calls.push(args);
      // The rev-parse call resolves to the reviewed SHA.
      if (args.includes("rev-parse")) return { stdout: `${sha}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await expect(pinReproMirror(run, dir, sha, 7)).resolves.toBeUndefined();

    // The fetch of the advertised PR head into the pin ref…
    expect(calls[0]).toEqual([
      "-C",
      dir,
      "fetch",
      "--quiet",
      "origin",
      "--",
      `refs/pull/7/head:refs/pinned/${sha}`,
    ]);
    // …then the SHA-resolving verify (the FIX 1 command — NOT `rev-parse -- <ref>`).
    expect(calls[1]).toEqual(["-C", dir, "rev-parse", "--verify", `refs/pinned/${sha}^{commit}`]);
  });

  it("FAILS the spec with a clear reason when the resolved head != reviewed sha (force-push)", async () => {
    const run: GitRun = async (_file, args) => {
      if (args.includes("rev-parse")) return { stdout: "0000badc0mm1t\n", stderr: "" };
      return { stdout: "", stderr: "" };
    };
    await expect(pinReproMirror(run, dir, sha, 7)).rejects.toThrow(
      /head resolved to 0000badc0mm1t, not the reviewed sha abc1234def5678/,
    );
    await expect(pinReproMirror(run, dir, sha, 7)).rejects.toThrow(/force-pushed/);
  });

  it("does NOT rev-parse for a non-PR review (prNumber <= 0) — pins the raw SHA", async () => {
    const calls: Array<readonly string[]> = [];
    const run: GitRun = async (_file, args) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };
    await pinReproMirror(run, dir, sha, 0);
    // Single raw-SHA pin fetch, no rev-parse verify.
    expect(calls).toEqual([
      ["-C", dir, "fetch", "--quiet", "origin", "--", `${sha}:refs/pinned/${sha}`],
    ]);
    expect(calls.some((a) => a.includes("rev-parse"))).toBe(false);
  });
});

// ── parseSpecs: STRICT per-element validation (FIX 3). A null / {} / missing-
// field / wrong-typed element must be rejected loudly so the exec
// exception-recovery path can never dereference a null spec.
describe("parseSpecs", () => {
  const goodSpec = {
    reviewId: "rev-1",
    findingId: "abc-0",
    findingIndex: 0,
    repoUrl: "https://github.com/o/r.git",
    mirrorDir: "/tmp/antfleet-mirror-x.git",
    sha: "abc1234",
    patch: "diff --git a/x b/x\n",
    repro: { file: null, cmd: "pytest x", rationale: null, modelId: "m" },
    specDigest: "deadbeefdeadbeef",
  };

  it("accepts a well-formed specs array", () => {
    const specs = parseSpecs(JSON.stringify([goodSpec]));
    expect(specs).toHaveLength(1);
    expect(specs[0]?.findingId).toBe("abc-0");
  });

  it("accepts a spec whose repro.cmd is explicit null (a declined repro)", () => {
    const declined = {
      ...goodSpec,
      repro: { file: null, cmd: null, rationale: "x", modelId: "m" },
    };
    expect(() => parseSpecs(JSON.stringify([declined]))).not.toThrow();
  });

  it("rejects a non-array file", () => {
    expect(() => parseSpecs(JSON.stringify({ nope: true }))).toThrow(
      /did not contain a JSON array/,
    );
  });

  it("rejects a [null, goodSpec] file (a null element)", () => {
    expect(() => parseSpecs(JSON.stringify([null, goodSpec]))).toThrow(
      /repro-specs\[0\] is not an object/,
    );
  });

  it("rejects an empty-object element {}", () => {
    expect(() => parseSpecs(JSON.stringify([{}]))).toThrow(/repro-specs\[0\]\.reviewId/);
  });

  it("rejects a spec missing its mirror path (mirrorDir)", () => {
    const bad = { ...goodSpec, mirrorDir: "" };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.mirrorDir must be a non-empty string/,
    );
  });

  it("rejects a spec whose repro is not an object", () => {
    const bad = { ...goodSpec, repro: null };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(/repro-specs\[0\]\.repro must be/);
  });

  it("rejects a spec whose repro.cmd is a number", () => {
    const bad = { ...goodSpec, repro: { ...goodSpec.repro, cmd: 42 } };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.repro\.cmd must be a string or null/,
    );
  });

  // FIX 3 — strict over EVERY field, not just a subset.
  it("rejects a spec missing findingIndex", () => {
    const { findingIndex: _drop, ...bad } = goodSpec;
    void _drop;
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.findingIndex must be an integer >= 0/,
    );
  });

  it("rejects a spec whose findingIndex is negative or non-integer", () => {
    expect(() => parseSpecs(JSON.stringify([{ ...goodSpec, findingIndex: -1 }]))).toThrow(
      /findingIndex must be an integer >= 0/,
    );
    expect(() => parseSpecs(JSON.stringify([{ ...goodSpec, findingIndex: 1.5 }]))).toThrow(
      /findingIndex must be an integer >= 0/,
    );
  });

  it("rejects a spec missing repoUrl", () => {
    const { repoUrl: _drop, ...bad } = goodSpec;
    void _drop;
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.repoUrl must be a string/,
    );
  });

  it("rejects a spec missing specDigest", () => {
    const bad = { ...goodSpec, specDigest: "" };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.specDigest must be a non-empty string/,
    );
  });

  it("rejects a spec whose repro.rationale is a number", () => {
    const bad = { ...goodSpec, repro: { ...goodSpec.repro, rationale: 7 } };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.repro\.rationale must be a string or null/,
    );
  });

  it("rejects a spec whose repro.modelId is a number", () => {
    const bad = { ...goodSpec, repro: { ...goodSpec.repro, modelId: 42 } };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.repro\.modelId must be a string or null/,
    );
  });

  it("accepts a spec whose repro.modelId is explicit null", () => {
    const ok = { ...goodSpec, repro: { ...goodSpec.repro, modelId: null } };
    expect(() => parseSpecs(JSON.stringify([ok]))).not.toThrow();
  });

  it("rejects a spec whose repro.file is a half-formed object (missing contents)", () => {
    const bad = { ...goodSpec, repro: { ...goodSpec.repro, file: { path: "x.py" } } };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.repro\.file must have string path and contents/,
    );
  });

  it("rejects a spec whose repro.file is a non-object non-null (a string)", () => {
    const bad = { ...goodSpec, repro: { ...goodSpec.repro, file: "nope" } };
    expect(() => parseSpecs(JSON.stringify([bad]))).toThrow(
      /repro-specs\[0\]\.repro\.file must be an object or null/,
    );
  });

  it("accepts a spec whose repro.file is a well-formed {path,contents} object", () => {
    const ok = {
      ...goodSpec,
      repro: { ...goodSpec.repro, file: { path: "repro_test.py", contents: "assert True\n" } },
    };
    expect(() => parseSpecs(JSON.stringify([ok]))).not.toThrow();
  });
});

// ── parseVerdicts: STRICT shape validation + the verified-proof invariant (FIX B).
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

  it("rejects a null element", () => {
    expect(() => parseVerdicts(JSON.stringify([null]))).toThrow(
      /repro-verdicts\[0\] is not an object/,
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

  it("rejects a record missing an enriched field (sha)", () => {
    const bad = { ...good, sha: "" };
    expect(() => parseVerdicts(JSON.stringify([bad]))).toThrow(/sha must be a non-empty string/);
  });

  // PROOF INVARIANT (FIX B): a forged `verified` with null / weak proofs is rejected.
  it("rejects a verified record with detector:'none'", () => {
    const forged = { ...good, detector: "none" };
    expect(() => parseVerdicts(JSON.stringify([forged]))).toThrow(/without a valid proof/);
  });

  it("rejects a verified record with a null reproPostExitCode", () => {
    const forged = { ...good, reproPostExitCode: null };
    expect(() => parseVerdicts(JSON.stringify([forged]))).toThrow(/without a valid proof/);
  });

  it("rejects a verified record with a zero reproPostExitCode (bug not closed)", () => {
    const forged = { ...good, reproPostExitCode: 0 };
    expect(() => parseVerdicts(JSON.stringify([forged]))).toThrow(/without a valid proof/);
  });

  it("rejects a verified record with a non-zero testExitCode", () => {
    const forged = { ...good, testExitCode: 1 };
    expect(() => parseVerdicts(JSON.stringify([forged]))).toThrow(/without a valid proof/);
  });

  it("rejects a verified record that also carries an inconclusiveReason", () => {
    const forged = { ...good, inconclusiveReason: "exception" };
    expect(() => parseVerdicts(JSON.stringify([forged]))).toThrow(/without a valid proof/);
  });

  it("does NOT apply the verified-invariant to inconclusive/regressed records", () => {
    const inconclusive = {
      ...good,
      verdict: "inconclusive",
      inconclusiveReason: "no_runner",
      detector: "none",
      testExitCode: null,
      reproPostExitCode: null,
    };
    expect(() => parseVerdicts(JSON.stringify([inconclusive]))).not.toThrow();
  });

  // FIX 4 — detector must be validated against the real RunnerKind domain
  // (pnpm|npm|go|pytest|none) for EVERY record, and a `verified` must name a REAL
  // runner (not "", "bogus", or "none").
  it("rejects ANY record (even inconclusive) whose detector is out of the RunnerKind domain", () => {
    const badInconclusive = {
      ...good,
      verdict: "inconclusive",
      inconclusiveReason: "no_runner",
      detector: "bogus",
      testExitCode: null,
      reproPostExitCode: null,
    };
    expect(() => parseVerdicts(JSON.stringify([badInconclusive]))).toThrow(
      /detector must be one of pnpm\|npm\|go\|pytest\|none/,
    );
  });

  it('rejects a verified record whose detector is empty ("")', () => {
    const forged = { ...good, detector: "" };
    expect(() => parseVerdicts(JSON.stringify([forged]))).toThrow(
      /detector must be one of pnpm\|npm\|go\|pytest\|none/,
    );
  });

  it("rejects a verified record whose detector is a bogus (out-of-domain) runner", () => {
    const forged = { ...good, detector: "bogus" };
    expect(() => parseVerdicts(JSON.stringify([forged]))).toThrow(
      /detector must be one of pnpm\|npm\|go\|pytest\|none/,
    );
  });

  it("accepts a verified record for each REAL runner detector (npm/go/pytest)", () => {
    for (const detector of ["npm", "go", "pytest"] as const) {
      expect(() => parseVerdicts(JSON.stringify([{ ...good, detector }]))).not.toThrow();
    }
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
    const writeGateOutcome = vi.fn(async () => true);
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
        return true; // the DB inserted the row (FIX 6a)
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
        return true;
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
      return true;
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

  // FIX 6a — a writer that reports NO insert (ON CONFLICT DO NOTHING no-op, e.g. a
  // concurrent run that wrote the row between our existence pre-check and the
  // insert) must NOT be counted in `written`. It is reported as skipped instead.
  it("does NOT count a write that the DB did not insert (ON CONFLICT no-op) (FIX 6a)", async () => {
    const logs: string[] = [];
    // Existence pre-check says "new", but the write reports false: the second
    // verdict lost the insert race and DID NOTHING.
    const writeGateOutcome = vi.fn(async (reviewId: string, _row: { findingId: string }) => {
      return reviewId === "rev-1"; // rev-1 inserted; rev-2 was a no-op
    });
    const written = await runRecordPhase({
      inPath: "unused.json",
      record: true,
      loadVerdicts: async () => verdicts,
      writeGateOutcome,
      gateOutcomeExists: async () => false,
      log: (m) => logs.push(m),
    });
    // Only the row the DB actually inserted counts.
    expect(written).toBe(1);
    expect(writeGateOutcome).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => /no-op \(already recorded by a concurrent run\)/.test(l))).toBe(true);
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
