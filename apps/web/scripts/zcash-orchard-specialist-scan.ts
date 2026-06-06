/**
 * One-off: retro scan with a halo2-specialist prompt wrap.
 *
 * Mirrors run-retro-scan.ts exactly — same provider stack, same models, same
 * file-filter constants — but inserts a domain-context block describing the
 * class of circuit-soundness bugs to look for. The point is to measure the
 * recall lift from telling the generalist reviewer that it is reading halo2
 * circuit Rust, *without* spoilering the specific Orchard counterfeiting bug.
 *
 * Used to produce the blind-specialist evidence bundle behind
 * /retro/zcash-orchard-counterfeit-2026-05. Use a neutral --label to avoid
 * leaking the bug class into the prompt — see
 * memory/feedback_neutralize_retro_labels.md.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/zcash-orchard-specialist-scan.ts \
 *     --repo zcash/halo2 \
 *     --pr-sha cc9dd20536ecd3bd3732f4ff2dc5ee230a27de55 \
 *     --case-id zcash-halo2-cc9dd205-blind-specialist \
 *     --label "halo2 ecc chip variable-base scalar mul implementation" \
 *     --loss-usd 0 \
 *     --incident-date 2026-05-29
 *
 * Reads: ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN (optional).
 * Writes: .omc/research/<case-id>-evidence.json
 *         .omc/research/<case-id>-report.md
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, basename } from "node:path";
import { execSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { buildSpikePrompt } from "@antfleet/cli/spike/build-prompt";
import { anthropicProvider, ANTHROPIC_DEFAULT_MODEL } from "@antfleet/cli/providers/anthropic";
import { openaiProvider, OPENAI_DEFAULT_MODEL } from "@antfleet/cli/providers/openai";
import type { ReviewOutput } from "@antfleet/cli/types";

const SPECIALIST_CONTEXT = `Domain context — read before reviewing:

The files below are halo2 zero-knowledge circuit code (Rust), part of the
Zcash Orchard ECC chip. In halo2, circuit constraints come from two places:
(a) custom polynomial gates that are only active on rows where a selector
is enabled, and (b) the permutation argument that ties together cells
written via \`copy_advice\` / \`constrain_equal\`. A value written with
\`assign_advice\` alone is *not* bound to anything — the prover is free to
choose it. Soundness depends on every prover-supplied cell either being
constrained by an active polynomial gate or copy-constrained to a value
that is itself bound.

Classes of soundness defect specific to this style of code:

1. **Under-constrained advice cells.** A cell that the prover supplies
   (\`assign_advice\` with a witness) and that no active gate constrains
   over its full domain. The prover substitutes an arbitrary value and
   the resulting proof still verifies.

2. **Constraint-scope gaps.** Selectors only enable gates on the rows
   they are turned on. A value that must remain constant across N rows,
   or hold a specific relation across loop iterations, has to either be
   copy-constrained into each row or be covered by a gate active on every
   such row. A gate active on the wrong row, or off-by-one selector
   enable, breaks this silently.

3. **Missing chip-boundary anchoring.** When a value enters a gadget
   from another chip, from a public input, or from a caller-supplied
   point, it must be tied via the permutation argument. \`assign_advice\`
   alone does not bind it. The downstream gates may all be sound *given*
   the right input; if the input itself is free, the entire gadget is
   unsound.

4. **Lookup / range-check omission.** Values used as scalars, indices,
   or limbs that lack a range constraint (lookup table or decomposition)
   let the prover step outside the intended field/range.

5. **Conditional gates with missing fallback.** A gate of the form
   \`s * (A - B) = 0\` only constrains A=B when s=1; nothing about A or
   B is enforced when s=0. If A is supposed to hold a meaningful value
   in both cases, the s=0 branch is unconstrained.

These defects do NOT surface in unit tests that prove valid statements:
the honest prover produces a witness where everything happens to line up.
A soundness bug only manifests when a malicious prover constructs an
invalid witness — i.e. exactly what a test corpus of valid inputs cannot
exercise. Treat the \`correctness\` and \`security\` categories below as
covering soundness: any of the above is a \`security\` finding at
\`critical\` or \`high\` severity if exploited it would let a prover prove
a false statement.

Now perform the review per the instructions below.

`;

// ─── types (mirror run-retro-scan.ts) ─────────────────────────────────────────

type CliArgs = {
  repo: string;
  prSha: string;
  caseId: string;
  label: string;
  lossUsd: number;
  incidentDate: string;
};

type RawFile = { filename: string; status: string; sha: string; patch: string | null };
type ScanFile = { filename: string; contents: string; patch: string | null };
type ProviderResult = {
  name: string;
  modelId: string;
  output: ReviewOutput | null;
  error: string | null;
  ms: number;
};

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) throw new Error(`Missing required flag: ${flag}`);
    return argv[i + 1];
  };
  const lossStr = get("--loss-usd");
  const lossUsd = Number(lossStr);
  if (isNaN(lossUsd) || lossUsd < 0)
    throw new Error(`--loss-usd must be a non-negative number; got: ${lossStr}`);
  return {
    repo: get("--repo"),
    prSha: get("--pr-sha"),
    caseId: get("--case-id"),
    label: get("--label"),
    lossUsd,
    incidentDate: get("--incident-date"),
  };
}

const REVIEW_EXTENSIONS = new Set([
  ".cjs",
  ".go",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sol",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const REVIEW_BLOCKLIST_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "COPYING",
  ".gitignore",
  ".npmignore",
  ".prettierignore",
]);
const REVIEW_BLOCKLIST_SUFFIXES = [
  "/node_modules/",
  "/dist/",
  "/build/",
  "/coverage/",
  "/.next/",
  "/.vercel/",
  "/out/",
  ".gen.ts",
  ".generated.ts",
  ".generated.js",
  ".min.js",
  ".min.css",
  ".pb.go",
  ".pb.ts",
];
const MAX_FILE_BYTES = 80 * 1024;
const MAX_FILES = 15;
const MAX_TOTAL_BYTES = 150 * 1024;

function isReviewable(filename: string): boolean {
  if (!REVIEW_EXTENSIONS.has(extname(filename))) return false;
  if (REVIEW_BLOCKLIST_BASENAMES.has(basename(filename))) return false;
  for (const s of REVIEW_BLOCKLIST_SUFFIXES) if (filename.includes(s)) return false;
  return true;
}

async function fetchCommitFiles(
  o: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<RawFile[]> {
  const { data } = await o.rest.repos.getCommit({ owner, repo, ref: sha });
  return (data.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    sha: f.sha ?? "",
    patch: f.patch ?? null,
  }));
}

async function fetchFileContent(
  o: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ content: string; bytes: number } | null> {
  try {
    const { data } = await o.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string")
      return null;
    const buf = Buffer.from(data.content, "base64");
    if (buf.byteLength > MAX_FILE_BYTES) return null;
    return { content: buf.toString("utf8"), bytes: buf.byteLength };
  } catch {
    return null;
  }
}

function providerCaught(output: ReviewOutput | null, introducingFilenames: Set<string>): boolean {
  if (!output) return false;
  return output.findings.some((f) => f.evidence.some((e) => introducingFilenames.has(e.path)));
}

function findingsMd(findings: ReviewOutput["findings"]): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((f) => {
      const loc = f.evidence[0]
        ? `${f.evidence[0].path}:${f.evidence[0].startLine ?? "?"}`
        : "(no location)";
      return `- **${f.title}** (${f.severity}/${f.confidence}) — \`${loc}\`\n  ${f.reasoning.slice(0, 400)}`;
    })
    .join("\n");
}

async function main() {
  const args = parseArgs();
  const [owner, repo] = args.repo.split("/") as [string, string];

  console.log(`\n[specialist-scan] ${args.caseId}`);
  console.log(`  repo      : ${args.repo}`);
  console.log(`  sha       : ${args.prSha}`);
  console.log(`  label     : ${args.label}`);

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  console.log("\n[1/4] fetching commit file list ...");
  const rawFiles = await fetchCommitFiles(octokit, owner, repo, args.prSha);
  const reviewable = rawFiles
    .filter((f) => f.status !== "removed" && isReviewable(f.filename))
    .slice(0, MAX_FILES);
  console.log(`  ${rawFiles.length} files in commit → ${reviewable.length} reviewable`);

  console.log("[2/4] fetching file contents ...");
  const scanFiles: ScanFile[] = [];
  let totalBytes = 0;
  for (const f of reviewable) {
    const result = await fetchFileContent(octokit, owner, repo, f.filename, args.prSha);
    let contents: string;
    let chargeBytes: number;
    if (result !== null) {
      contents = result.content;
      chargeBytes = result.bytes;
    } else if (f.patch) {
      const header = `[OVERSIZE FILE — exceeds ${MAX_FILE_BYTES / 1024}KB; showing unified diff only]\n`;
      contents = header + f.patch;
      chargeBytes = Buffer.byteLength(contents, "utf8");
      if (chargeBytes > MAX_FILE_BYTES) continue;
    } else {
      continue;
    }
    if (totalBytes + chargeBytes > MAX_TOTAL_BYTES) break;
    totalBytes += chargeBytes;
    scanFiles.push({ filename: f.filename, contents, patch: f.patch });
  }
  console.log(`  ${scanFiles.length} files fetched, ${(totalBytes / 1024).toFixed(1)} KB total`);
  if (scanFiles.length === 0) throw new Error("No reviewable files in commit.");

  const basePrompt = buildSpikePrompt({
    projectName: `github:${args.repo}`,
    projectRoot: ".",
    featureId: args.caseId,
    featureTitle: `${args.label} — commit ${args.prSha.slice(0, 8)}`,
    files: scanFiles.map((f) => ({ path: f.filename, contents: f.contents })),
  });
  const prompt = SPECIALIST_CONTEXT + basePrompt;
  const promptSha = createHash("sha256").update(prompt).digest("hex");
  console.log(`  prompt SHA: ${promptSha.slice(0, 16)}... (specialist-wrapped)`);

  console.log("[3/4] running two-model review (60-120s) ...");
  const t0 = Date.now();
  const STACK = [
    { name: "anthropic" as const, provider: anthropicProvider, modelId: ANTHROPIC_DEFAULT_MODEL },
    { name: "openai" as const, provider: openaiProvider, modelId: OPENAI_DEFAULT_MODEL },
  ];
  const results: ProviderResult[] = await Promise.all(
    STACK.map(async ({ name, provider, modelId }) => {
      const start = Date.now();
      try {
        const output = await provider.review(".", prompt, null);
        console.log(
          `  [${name}] ${output.findings.length} finding(s) in ${((Date.now() - start) / 1000).toFixed(1)}s`,
        );
        return { name, modelId, output, error: null, ms: Date.now() - start };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.log(`  [${name}] ERROR: ${error.slice(0, 120)}`);
        return { name, modelId, output: null, error, ms: Date.now() - start };
      }
    }),
  );
  console.log(`  total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const introducingFilenames = new Set(scanFiles.map((f) => f.filename));
  const caught = results.map((r) => providerCaught(r.output, introducingFilenames));
  const nCaught = caught.filter(Boolean).length;
  const outcome: "A" | "B" | "C" = nCaught === 2 ? "A" : nCaught === 1 ? "B" : "C";
  const caughtNames = results.filter((_, i) => caught[i]).map((r) => r.name);
  const missedNames = results.filter((_, i) => !caught[i]).map((r) => r.name);
  const outcomeRationale =
    outcome === "A"
      ? `Both ${caughtNames.join(" and ")} produced findings in the introducing commit's files. Unanimous gate would have fired.`
      : outcome === "B"
        ? `${caughtNames[0]} produced findings; ${missedNames[0]} did not. Split — unanimous gate would not have fired.`
        : `Neither provider produced findings in the introducing commit's files. Unanimous gate would not have fired.`;

  console.log(`\n  OUTCOME: ${outcome}`);
  console.log(`  ${outcomeRationale}`);

  console.log("\n[4/4] writing output files ...");
  const researchDir = join(process.cwd(), "../../.omc/research");
  mkdirSync(researchDir, { recursive: true });

  let pipelineCommitSha = "";
  try {
    pipelineCommitSha = execSync("git rev-parse HEAD", { cwd: join(process.cwd(), "../..") })
      .toString()
      .trim();
  } catch {
    // non-fatal
  }

  const anthropicResult = results.find((r) => r.name === "anthropic");
  const openaiResult = results.find((r) => r.name === "openai");

  const evidence = {
    caseId: args.caseId,
    label: args.label,
    incidentDate: args.incidentDate,
    lossesUsd: args.lossUsd,
    repo: args.repo,
    introducingPrSha: args.prSha,
    introducingFiles: scanFiles.map((f) => f.filename),
    promptVariant: "specialist-halo2",
    promptSha,
    pipelineVersion: "0.1.0-specialist",
    pipelineCommitSha,
    modelIds: { anthropic: ANTHROPIC_DEFAULT_MODEL, openai: OPENAI_DEFAULT_MODEL },
    scannedAt: new Date().toISOString(),
    anthropicRawFindings: anthropicResult?.output?.findings ?? [],
    openaiRawFindings: openaiResult?.output?.findings ?? [],
    anthropicError: anthropicResult?.error ?? null,
    openaiError: openaiResult?.error ?? null,
    outcome,
    outcomeRationale,
  };

  const evidencePath = join(researchDir, `${args.caseId}-evidence.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`  evidence: ${evidencePath}`);

  const reportMd = `# Specialist retro-scan — ${args.caseId}

**Outcome:** ${outcome} — ${outcomeRationale}

## Methodology
- Repo: ${args.repo}@${args.prSha}
- Prompt variant: specialist-halo2 (generalist prompt prefixed with halo2 circuit-soundness context — see SPECIALIST_CONTEXT in _zcash-orchard-specialist-scan.ts)
- Prompt SHA: ${promptSha}
- Models: ${ANTHROPIC_DEFAULT_MODEL}, ${OPENAI_DEFAULT_MODEL}
- Scanned at: ${evidence.scannedAt}

## Per-provider findings (raw)

### Anthropic (${ANTHROPIC_DEFAULT_MODEL})
${anthropicResult?.error ? `ERROR: ${anthropicResult.error}` : findingsMd(anthropicResult?.output?.findings ?? [])}

### OpenAI (${OPENAI_DEFAULT_MODEL})
${openaiResult?.error ? `ERROR: ${openaiResult.error}` : findingsMd(openaiResult?.output?.findings ?? [])}
`;
  const reportPath = join(researchDir, `${args.caseId}-report.md`);
  writeFileSync(reportPath, reportMd, "utf8");
  console.log(`  report  : ${reportPath}`);
}

main().catch((err) => {
  console.error("\n[specialist-scan] FAILED");
  console.error(err);
  process.exit(1);
});
