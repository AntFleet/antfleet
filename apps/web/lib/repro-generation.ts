// Repro-test generation (issue #133, Build 2) — per-review executable-repro
// generator.
//
// Mirrors the Patch Agent's patch-generation orchestrator (patch-generation.ts).
// For each confirmed finding, calls the provider's `proposeReproTest` with a
// 60s timeout, then applies post-call validation: the run `cmd` must pass the
// SAME allowlist + shell-metacharacter gate the PoC verifier uses
// (matchesPocCommandAllowlist, extracted from patch-verifier's sniffPocCommand),
// the repro `file.path` must be a safe repo-relative path (no traversal, no
// leading slash), and `file.contents` must be within the size cap.
//
// Pure-orchestration: this module does no DB I/O, posts no comments, and is
// NOT wired into the review path in this build. It returns a structured
// payload a follow-up (Build 2b) will consume — running the generated repro
// through the patch-verifier's same-safe runner.
//
// SEMANTIC CONVENTION (Build 2b depends on this): the generated repro is
// authored to exit 0 (success) against the CURRENT, UNPATCHED source
// (success == the bug reproduces) and exit non-zero once the finding's
// recommended fix is applied. This matches patch-verifier.ts, which treats
// `pocStep.exitCode === 0` as "still exploits". The rule is stated verbatim
// in buildReproTestPrompt so the model authors repros the runner can interpret.

import type { Finding } from "./review-types";
import type { ChangedFile } from "./github-files";
import { extractSourceWindow, type SourceExcerpt } from "./patch-generation";
import { matchesPocCommandAllowlist } from "./patch-verifier";
import type { ReproTestSuggestion } from "@antfleet/cli/types";

// Per-call timeout. Mirrors PATCH_GENERATION_TIMEOUT_MS: the whole review must
// finish under 240s and the per-provider review call already burns ~60s, so
// the repro call budget is matched at 60s to keep parallel wall-clock
// predictable.
export const REPRO_GENERATION_TIMEOUT_MS = 60_000;

// Cap the generated repro file at 8000 BYTES. Build 2b writes this to disk, so
// the meaningful budget is bytes — UTF-16 `.length` under-counts multibyte
// content. A repro needing a bigger file falls through to skipReason="size_cap".
export const REPRO_FILE_MAX_BYTES = 8000;

// Skip reasons a repro proposal can carry. `null` skipReason with a null
// reproTest means the model declined cleanly (see runOneReproProposal).
export type ReproSkipReason =
  | "no_evidence"
  | "generation_error"
  | "cmd_not_allowlisted"
  | "unsafe_file_path"
  | "size_cap";

// One repro result per finding. `reproTest` is null when the finding was
// skipped (skipReason set) OR when the model declined (cmd=null, skipReason
// null, rationale preserved on the returned suggestion). Build 2b keys off
// findingId.
export type ReproProposal = {
  findingId: string;
  reproTest: ReproTestSuggestion | null;
  skipReason: ReproSkipReason | null;
};

export type ReproGenerationResult = {
  proposals: ReproProposal[];
  // Total wall-clock for the fan-out, for logging + future re-pricing.
  elapsedMs: number;
};

// Provider surface this orchestrator needs. Matches the optional
// `proposeReproTest` method on @antfleet/cli's Provider type. Declared
// structurally (mirroring PatchProposingProvider) so the test suite can inject
// a mock without pulling the whole Provider interface. Single-model for now,
// so this takes one provider rather than a providers[] array.
export type ReproProposingProvider = {
  name: string;
  proposeReproTest: (
    root: string,
    prompt: string,
    model: string | null,
  ) => Promise<ReproTestSuggestion>;
};

export type GenerateReproTestArgs = {
  reviewId: string;
  findings: readonly Finding[];
  // findingId aligned with findings[] index — the caller derives this before
  // persisting. Passed explicitly so the orchestrator doesn't depend on the DB
  // helper (mirrors generateReviewPatches).
  findingIds: readonly string[];
  changedFiles: readonly ChangedFile[];
  // Injectable per-finding repro call (mirror of PatchProposingProvider). A
  // mock makes the orchestrator unit-testable without a live provider.
  provider: ReproProposingProvider;
  model?: string | null;
  // For tests. Production callers omit and the orchestrator uses Date.now.
  now?: () => number;
  // For tests. Production callers omit and the orchestrator uses the default.
  timeoutMs?: number;
};

/**
 * Fan out per-finding repro generation. Returns one `ReproProposal` per
 * finding. Single-model (anthropic), so unlike generateReviewPatches there is
 * one call per finding rather than per (finding × provider) pair.
 *
 * Failure isolation:
 *   - No evidence on the finding → `{ reproTest: null, skipReason: "no_evidence" }`
 *     with no provider call.
 *   - Provider throw / timeout → `{ reproTest: null, skipReason: "generation_error" }`.
 *   - `cmd` failing the allowlist / metacharacter gate →
 *     `{ reproTest: null, skipReason: "cmd_not_allowlisted" }`.
 *   - `file.path` traversal / absolute / empty →
 *     `{ reproTest: null, skipReason: "unsafe_file_path" }`.
 *   - `file.contents` over the cap → `{ reproTest: null, skipReason: "size_cap" }`.
 *   - `cmd: null` decline from the model → carried through with reproTest=null
 *     and skipReason=null; the rationale is preserved on the returned
 *     suggestion so 2b can surface WHY no repro was written.
 */
export async function generateReproTest(
  args: GenerateReproTestArgs,
): Promise<ReproGenerationResult> {
  const now = args.now ?? Date.now;
  const timeoutMs = args.timeoutMs ?? REPRO_GENERATION_TIMEOUT_MS;
  const t0 = now();

  if (args.findings.length !== args.findingIds.length) {
    throw new Error(
      `generateReproTest: findings (${args.findings.length}) and findingIds (${args.findingIds.length}) must align`,
    );
  }

  // Real source of each changed file, keyed by normalized path — feeds the
  // source window into the prompt so the model writes a repro against actual
  // code rather than reconstructing it from the finding prose.
  const contentsByPath = new Map<string, string>();
  for (const f of args.changedFiles) {
    contentsByPath.set(normalizePath(f.filename), f.contents);
  }

  const calls: Array<Promise<ReproProposal>> = [];
  for (const [index, finding] of args.findings.entries()) {
    const findingId = args.findingIds[index];
    if (findingId === undefined) continue;
    calls.push(
      runOneReproProposal({
        provider: args.provider,
        finding,
        findingId,
        contentsByPath,
        model: args.model ?? null,
        timeoutMs,
      }),
    );
  }

  const proposals = await Promise.all(calls);
  return { proposals, elapsedMs: now() - t0 };
}

type RunOneReproProposalArgs = {
  provider: ReproProposingProvider;
  finding: Finding;
  findingId: string;
  contentsByPath: ReadonlyMap<string, string>;
  model: string | null;
  timeoutMs: number;
};

async function runOneReproProposal(args: RunOneReproProposalArgs): Promise<ReproProposal> {
  // Step 1: precheck — a finding with no evidence gives the model nothing to
  // anchor a repro against. Skip the API call (no token spend).
  const evidence = args.finding.evidence[0];
  if (evidence === undefined) {
    return { findingId: args.findingId, reproTest: null, skipReason: "no_evidence" };
  }

  // Step 2: feed the model the REAL source window around the evidence so the
  // repro references actual code. Falls back to no source block when the
  // evidence file isn't in the changed set (extractSourceWindow reused as-is).
  const sourceExcerpt = ((): SourceExcerpt | null => {
    const fc = args.contentsByPath.get(normalizePath(evidence.path));
    return fc === undefined ? null : extractSourceWindow(fc, evidence.startLine, evidence.endLine);
  })();

  // Step 3: provider call with a hard timeout. A throw/timeout means the call
  // may have burned tokens upstream but we never received usage — record the
  // skip and move on (failure isolation).
  let raw: ReproTestSuggestion;
  try {
    raw = await withTimeout(
      args.provider.proposeReproTest(
        ".",
        buildReproTestPrompt(args.finding, sourceExcerpt),
        args.model,
      ),
      args.timeoutMs,
    );
  } catch {
    return { findingId: args.findingId, reproTest: null, skipReason: "generation_error" };
  }

  // Step 4: decline path. cmd=null means the model could not write a
  // self-contained repro from the shown source. Carry the suggestion through
  // (rationale preserved) with no skipReason — this is a clean opt-out, not a
  // validation failure.
  if (raw.cmd === null) {
    // A decline carries no runnable repro, so it carries no file to write. Null
    // the file so a declined suggestion can never smuggle an unvalidated
    // (traversal / oversize) file past Build 2b's writer.
    return { findingId: args.findingId, reproTest: { ...raw, file: null }, skipReason: null };
  }

  // Step 5: cmd validation. This is a SECURITY surface — Build 2b executes the
  // returned cmd in the sandbox — so it routes through the exact same
  // allowlist + shell-metacharacter gate the PoC verifier uses. A cmd that
  // isn't an allowlisted runner, or contains a shell metacharacter, is
  // rejected outright.
  if (matchesPocCommandAllowlist(raw.cmd) === null) {
    return { findingId: args.findingId, reproTest: null, skipReason: "cmd_not_allowlisted" };
  }

  // Step 6: file validation (only when the repro writes a file — a bare curl
  // repro may have file=null). The path must be repo-relative with no
  // traversal or leading slash, and the contents must fit the cap.
  if (raw.file !== null) {
    if (!isSafeReproPath(raw.file.path)) {
      return { findingId: args.findingId, reproTest: null, skipReason: "unsafe_file_path" };
    }
    if (Buffer.byteLength(raw.file.contents, "utf8") > REPRO_FILE_MAX_BYTES) {
      return { findingId: args.findingId, reproTest: null, skipReason: "size_cap" };
    }
  }

  return { findingId: args.findingId, reproTest: raw, skipReason: null };
}

// Repro file paths are written into the repo root by Build 2b's runner. Refuse
// anything that could escape the repo root or clobber an absolute location:
// no empty path, no leading `/`, no `..` traversal segment, no Windows drive/
// backslash. Mirrors the conservative posture of patch-verifier's path checks.
export function isSafeReproPath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.length > 500) return false;
  if (path.startsWith("/")) return false;
  // Windows absolute (C:\...) or any backslash — normalize to forward slashes
  // is not attempted; a backslash in a repo-relative POSIX path is suspicious.
  if (path.includes("\\")) return false;
  if (/^[A-Za-z]:/u.test(path)) return false;
  // Reject a `..` traversal segment anywhere in the path.
  const segments = path.split("/");
  if (segments.some((seg) => seg === "..")) return false;
  return true;
}

// Prompt for the proposeReproTest call. Mirrors buildPatchPrompt: embeds the
// finding fields + the REAL source window (when available) and instructs the
// model to write a MINIMAL, self-contained executable repro. The exit-0-on-vuln
// convention is stated as a HARD rule (Build 2b depends on it).
export function buildReproTestPrompt(
  finding: Finding,
  sourceExcerpt: SourceExcerpt | null = null,
): string {
  const ev = finding.evidence[0];
  const target = ev === undefined ? "(unknown)" : formatEvidencePath(ev);
  const reproduction = finding.reproduction === null ? "(none provided)" : finding.reproduction;
  const sourceBlock =
    sourceExcerpt === null
      ? []
      : [
          `SOURCE — exact current (UNPATCHED) contents of ${target} (starting at line ${sourceExcerpt.firstLine}).`,
          `Write your repro against THIS code — it is what the repro runs against before any fix:`,
          "```",
          sourceExcerpt.text,
          "```",
          ``,
        ];
  return [
    `You previously flagged a ${finding.category} (${finding.severity}) finding titled:`,
    `  ${finding.title}`,
    ``,
    `Target: ${target}`,
    ``,
    `Reasoning: ${finding.reasoning}`,
    `Recommendation: ${finding.recommendation}`,
    `Reproduction: ${reproduction}`,
    ``,
    ...sourceBlock,
    `Write a MINIMAL, self-contained executable repro (a PoC / test) that PROVES this finding's bug.`,
    ``,
    `HARD RULES:`,
    `  1. EXIT-CODE CONVENTION (load-bearing — a downstream runner keys off it):`,
    `     the repro MUST exit 0 (success) when run against the CURRENT, UNPATCHED`,
    `     source shown above — i.e. exit 0 == the bug reproduces. It MUST exit`,
    `     NON-ZERO once the finding's recommended fix is applied. Do NOT invert`,
    `     this: a normal passing test (green == fixed) is WRONG here. Success`,
    `     means the vulnerability is present.`,
    `  2. The repro must be MINIMAL and self-contained: no external network`,
    `     access except curl to localhost, no reliance on unshown project code`,
    `     beyond what the SOURCE block and standard library provide.`,
    `  3. "cmd" is how to run the repro and MUST start with one of these runners:`,
    `     pytest, go test, node, pnpm exec, npx, npm test, pnpm test, curl, bash, sh.`,
    `     It MUST NOT contain shell metacharacters (| & ; < > $ \` \\). One command,`,
    `     no pipes or redirection.`,
    `  4. "file" is the test/PoC file to write into the repo ROOT, as`,
    `     { "path": "<relative path>", "contents": "<file body>" }. The path MUST`,
    `     be repo-relative — no leading "/", no ".." traversal. Set "file" to null`,
    `     ONLY when "cmd" needs no new file (e.g. a bare curl to a localhost URL).`,
    `     "contents" MUST be <= ${REPRO_FILE_MAX_BYTES} bytes.`,
    `  5. If you CANNOT write a self-contained repro from the shown source, return`,
    `     { "file": null, "cmd": null, "rationale": "<one sentence on WHY>" }. The`,
    `     rationale must explain WHY a repro is impossible (e.g. "needs a running`,
    `     database", "requires a deployed contract", "source not shown"). Do not`,
    `     describe what the repro would do.`,
    ``,
    `Examples of a valid "cmd": "pytest repro_test.py", "node repro.js",`,
    `"forge test --match-test testRepro" is NOT valid (forge is not an allowlisted`,
    `runner) — wrap such cases via an allowlisted runner or decline.`,
    ``,
    `Return JSON: { "file": { "path": "<string>", "contents": "<string>" } | null,`,
    `  "cmd": "<run command or null>", "rationale": "<string or null>" }.`,
  ].join("\n");
}

function formatEvidencePath(ev: NonNullable<Finding["evidence"][number]>): string {
  if (ev.startLine === null) return ev.path;
  if (ev.endLine === null || ev.endLine === ev.startLine) {
    return `${ev.path}:${ev.startLine}`;
  }
  return `${ev.path}:${ev.startLine}-${ev.endLine}`;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//u, "").replace(/\\/gu, "/");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(`repro generation exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      },
    );
  });
}
