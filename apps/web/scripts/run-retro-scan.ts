/**
 * Retro scan runner — fetches a public GitHub commit through AntFleet's
 * two-model unanimous review gate and writes a structured evidence report.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/run-retro-scan.ts \
 *     --repo openclaw/openclaw \
 *     --pr-sha 03586e3d0057b5975090d50dadcc5bc95b51f977 \
 *     --case-id openclaw-cve-2026-31998-synology-chat \
 *     --label "OpenClaw synology-chat plugin authorization bypass (CVE-2026-31998)" \
 *     --loss-usd 0 \
 *     --incident-date 2026-03-18
 *
 * Reads: ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN (optional; raises rate limits).
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

// ─── types ────────────────────────────────────────────────────────────────────

type CliArgs = {
  repo: string;
  prSha: string;
  caseId: string;
  label: string;
  lossUsd: number;
  incidentDate: string;
};

type RawFile = {
  filename: string;
  status: string;
  sha: string;
  patch: string | null;
};

type ScanFile = {
  filename: string;
  contents: string;
  patch: string | null;
};

type ProviderResult = {
  name: string;
  modelId: string;
  output: ReviewOutput | null;
  error: string | null;
  ms: number;
};

// ─── arg parsing ──────────────────────────────────────────────────────────────

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

// ─── file filtering (mirrors github-files.ts constants) ───────────────────────

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
  for (const s of REVIEW_BLOCKLIST_SUFFIXES) {
    if (filename.includes(s)) return false;
  }
  return true;
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

async function fetchCommitFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<RawFile[]> {
  const { data } = await octokit.rest.repos.getCommit({ owner, repo, ref: sha });
  return (data.files ?? []).map((f) => ({
    filename: f.filename,
    status: f.status,
    sha: f.sha ?? "",
    patch: f.patch ?? null,
  }));
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ content: string; bytes: number } | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string")
      return null;
    const buf = Buffer.from(data.content, "base64");
    if (buf.byteLength > MAX_FILE_BYTES) return null; // caller falls back to patch
    return { content: buf.toString("utf8"), bytes: buf.byteLength };
  } catch {
    return null;
  }
}

// ─── outcome helpers ──────────────────────────────────────────────────────────

// A provider "catches" the introducing commit when it returns at least one
// finding whose evidence path matches a file in the introducing commit. This
// is the broadest honest criterion: any issue flagged in the introducing code
// would have triggered a unanimous-gate review cycle.
function providerCaught(output: ReviewOutput | null, introducingFilenames: Set<string>): boolean {
  if (!output) return false;
  return output.findings.some((f) => f.evidence.some((e) => introducingFilenames.has(e.path)));
}

// ─── report formatters ────────────────────────────────────────────────────────

function findingsMd(findings: ReviewOutput["findings"]): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((f) => {
      const loc = f.evidence[0]
        ? `${f.evidence[0].path}:${f.evidence[0].startLine ?? "?"}`
        : "(no location)";
      return `- **${f.title}** (${f.severity}/${f.confidence}) — \`${loc}\`\n  ${f.reasoning.slice(0, 300)}`;
    })
    .join("\n");
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const [owner, repo] = args.repo.split("/") as [string, string];

  console.log(`\n[retro-scan] ${args.caseId}`);
  console.log(`  repo      : ${args.repo}`);
  console.log(`  sha       : ${args.prSha}`);
  console.log(`  label     : ${args.label}`);
  console.log(`  loss-usd  : ${args.lossUsd}`);
  console.log(`  date      : ${args.incidentDate}`);

  // 1. Fetch commit files
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  console.log("\n[1/4] fetching commit file list ...");
  const rawFiles = await fetchCommitFiles(octokit, owner, repo, args.prSha);
  const reviewable = rawFiles
    .filter((f) => f.status !== "removed" && isReviewable(f.filename))
    .slice(0, MAX_FILES);
  console.log(`  ${rawFiles.length} files in commit → ${reviewable.length} reviewable`);

  // 2. Fetch file contents
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

  if (scanFiles.length === 0) {
    throw new Error("No reviewable files found in the introducing commit. Cannot run scan.");
  }

  // 3. Build prompt
  const prompt = buildSpikePrompt({
    projectName: `github:${args.repo}`,
    projectRoot: ".",
    featureId: args.caseId,
    featureTitle: `${args.label} — introducing commit ${args.prSha.slice(0, 8)}`,
    files: scanFiles.map((f) => ({ path: f.filename, contents: f.contents })),
  });
  const promptSha = createHash("sha256").update(prompt).digest("hex");
  console.log(`  prompt SHA: ${promptSha.slice(0, 16)}...`);

  // 4. Run providers in parallel
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
        console.log(`  [${name}] ERROR: ${error.slice(0, 80)}`);
        return { name, modelId, output: null, error, ms: Date.now() - start };
      }
    }),
  );
  console.log(`  total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 5. Compute outcome
  const introducingFilenames = new Set(scanFiles.map((f) => f.filename));
  const caught = results.map((r) => providerCaught(r.output, introducingFilenames));
  const nCaught = caught.filter(Boolean).length;
  const outcome: "A" | "B" | "C" = nCaught === 2 ? "A" : nCaught === 1 ? "B" : "C";

  const caughtNames = results.filter((_, i) => caught[i]).map((r) => r.name);
  const missedNames = results.filter((_, i) => !caught[i]).map((r) => r.name);

  const outcomeRationale =
    outcome === "A"
      ? `Both ${caughtNames.join(" and ")} produced findings in the introducing commit's files. AntFleet's unanimous gate would have fired.`
      : outcome === "B"
        ? `${caughtNames[0]} produced findings in the introducing commit's files; ${missedNames[0]} did not. The unanimous gate would not have fired (split verdict).`
        : `Neither provider produced findings in the introducing commit's files. The unanimous gate would not have fired.`;

  console.log(`\n  OUTCOME: ${outcome}`);
  console.log(`  ${outcomeRationale}`);

  // 6. Write output files
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

  // Evidence JSON — mirrors moonwell-*-evidence.json schema
  const evidence = {
    caseId: args.caseId,
    label: args.label,
    incidentDate: args.incidentDate,
    lossesUsd: args.lossUsd,
    repo: args.repo,
    introducingPrSha: args.prSha,
    introducingFiles: scanFiles.map((f) => f.filename),
    promptSha,
    promptFiles: [
      "apps/web/lib/review-pipeline.ts",
      "src/spike/build-prompt.ts",
      "src/providers/anthropic.ts",
      "src/providers/openai.ts",
    ],
    pipelineVersion: "0.1.0",
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

  // Report markdown — mirrors moonwell-*-report.md structure
  const reportMd = `# Retro scan report — ${args.caseId}

**Outcome:** ${outcome} — ${outcomeRationale}

## Methodology
- Repo: ${args.repo}@${args.prSha}
- Introducing commit: ${args.prSha}
- Prompt SHA: ${promptSha}
- Pipeline version: 0.1.0 @ ${pipelineCommitSha}
- Models: ${ANTHROPIC_DEFAULT_MODEL}, ${OPENAI_DEFAULT_MODEL}
- Scanned at: ${evidence.scannedAt}

## Verdict rationale
${outcomeRationale}

## Per-provider findings (raw)

### Anthropic (${ANTHROPIC_DEFAULT_MODEL})
${anthropicResult?.error ? `ERROR: ${anthropicResult.error}` : findingsMd(anthropicResult?.output?.findings ?? [])}

### OpenAI (${OPENAI_DEFAULT_MODEL})
${openaiResult?.error ? `ERROR: ${openaiResult.error}` : findingsMd(openaiResult?.output?.findings ?? [])}

## Reproduce this scan
\`\`\`
pnpm exec tsx apps/web/scripts/run-retro-scan.ts \\
  --repo ${args.repo} --pr-sha ${args.prSha} \\
  --case-id ${args.caseId} --label "${args.label}" \\
  --loss-usd ${args.lossUsd} --incident-date ${args.incidentDate}
\`\`\`

## Operator decision required
- Outcome A → publish \`/retro/${args.caseId}\` with "both reviewers caught it" framing
- Outcome B → publish with "one caught, one didn't — unanimous gate held" framing
- Outcome C → publish with honest "neither caught it" framing + what we'd change
`;

  const reportPath = join(researchDir, `${args.caseId}-report.md`);
  writeFileSync(reportPath, reportMd, "utf8");
  console.log(`  report  : ${reportPath}`);

  console.log(`\n[done] outcome ${outcome}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
