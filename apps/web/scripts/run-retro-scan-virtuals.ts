/**
 * Retro scan runner (Virtuals variant) - fetches a public GitHub commit
 * through AntFleet's two-model review gate routed via Virtuals and writes a
 * structured evidence report.
 *
 * Usage (from repo root):
 *   pnpm exec tsx apps/web/scripts/run-retro-scan-virtuals.ts \
 *     --repo openclaw/openclaw \
 *     --pr-sha 03586e3d0057b5975090d50dadcc5bc95b51f977 \
 *     --case-id openclaw-cve-2026-31998-synology-chat \
 *     --label "OpenClaw synology-chat plugin authorization bypass (CVE-2026-31998)" \
 *     --loss-usd 0 \
 *     --incident-date 2026-03-18
 *
 * Reads: apps/web/.env.local (VIRTUALS_API_KEY), GITHUB_TOKEN (optional; raises rate limits).
 * Writes: .omc/research/<case-id>-virtuals-evidence.json
 *         .omc/research/<case-id>-virtuals-report.md
 */
import { config as loadDotenv } from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { Octokit } from "@octokit/rest";
import { buildSpikePrompt } from "@antfleet/cli/spike/build-prompt";
import { reviewJsonSchema } from "@antfleet/cli/provider";
import { reviewOutputSchema, type ReviewOutput } from "@antfleet/cli/types";
import { VirtualsClient } from "../lib/virtuals-client";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(scriptDir);
const repoRoot = join(appRoot, "../..");

loadDotenv({ path: join(appRoot, ".env.local"), quiet: true });

// --- types -------------------------------------------------------------------

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

// --- arg parsing -------------------------------------------------------------

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) throw new Error(`Missing required flag: ${flag}`);
    return argv[i + 1];
  };
  const lossStr = get("--loss-usd");
  const lossUsd = Number(lossStr);
  if (isNaN(lossUsd) || lossUsd < 0) {
    throw new Error(`--loss-usd must be a non-negative number; got: ${lossStr}`);
  }
  return {
    repo: get("--repo"),
    prSha: get("--pr-sha"),
    caseId: get("--case-id"),
    label: get("--label"),
    lossUsd,
    incidentDate: get("--incident-date"),
  };
}

// --- file filtering (mirrors github-files.ts constants) ----------------------

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
// GPT-5 burns ~10K reasoning_tokens before emitting content on review-class
// prompts (measured 2026-06-10, probe captured in
// .omc/research/gpt5-empty-content-investigation-2026-06-10.md). 16384 left
// only ~6K of content budget and OOMed on longer reasoning chains; 32768
// gives ~22K headroom which fits the largest observed fleet_review payload
// (12,250 chars) with margin.
const MAX_TOKENS = 32768;

function isReviewable(filename: string): boolean {
  if (!REVIEW_EXTENSIONS.has(extname(filename))) return false;
  if (REVIEW_BLOCKLIST_BASENAMES.has(basename(filename))) return false;
  for (const s of REVIEW_BLOCKLIST_SUFFIXES) {
    if (filename.includes(s)) return false;
  }
  return true;
}

// --- GitHub helpers ----------------------------------------------------------

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
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      return null;
    }
    const buf = Buffer.from(data.content, "base64");
    if (buf.byteLength > MAX_FILE_BYTES) return null;
    return { content: buf.toString("utf8"), bytes: buf.byteLength };
  } catch {
    return null;
  }
}

// --- Virtuals provider route -------------------------------------------------

async function runVirtualsReview(
  client: VirtualsClient,
  modelId: string,
  prompt: string,
): Promise<ReviewOutput> {
  const stream = await client.streamChatCompletion({
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: MAX_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "fleet_review",
        schema: reviewJsonSchema,
        strict: true,
      },
    },
  });
  const content = stream.content;
  if (content === null || content === undefined || content.length === 0) {
    // Include finish_reason and reasoning_tokens so operators can distinguish
    // a reasoning_tokens × max_tokens budget OOM (finish_reason=length) from a
    // transport-side empty response or a real refusal. Without these fields
    // every failure looks identical in the persisted error string.
    const u = stream.usage;
    const reasoningTokens =
      // Virtuals surfaces OpenAI's completion_tokens_details on usage; the
      // type is `VirtualsUsage` which is a loose record, so reach for the
      // nested field defensively.
      (u as { completion_tokens_details?: { reasoning_tokens?: number } } | null)
        ?.completion_tokens_details?.reasoning_tokens ?? null;
    throw new Error(
      `Virtuals provider returned empty message content ` +
        `(finish_reason=${stream.finishReason}, reasoning_tokens=${reasoningTokens}, ` +
        `prompt_tokens=${u?.prompt_tokens ?? null}, completion_tokens=${u?.completion_tokens ?? null}, ` +
        `max_tokens=${MAX_TOKENS}, refusal=${stream.refusal === null ? "null" : "set"})`,
    );
  }
  return parseReviewOutput(content);
}

function parseReviewOutput(content: string): ReviewOutput {
  const json = JSON.parse(extractJsonObject(content));
  return reviewOutputSchema.parse(tolerateReviewShape(unwrapNestedInput(json)));
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  if (fenced?.[1]) return fenced[1].trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function tolerateReviewShape(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  const inspected = obj["inspected"];
  const inspectedOk =
    inspected !== null && typeof inspected === "object" && !Array.isArray(inspected);
  if (!inspectedOk) {
    obj["inspected"] = { files: [], symbols: [], notes: [] };
  }
  return obj;
}

function unwrapNestedInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    return raw;
  }
  const inner = obj[keys[0]!];
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) {
    return raw;
  }
  return inner;
}

// --- outcome helpers ---------------------------------------------------------

// A provider "catches" the introducing commit when it returns at least one
// finding whose evidence path matches a file in the introducing commit. This
// is the broadest honest criterion: any issue flagged in the introducing code
// would have triggered a unanimous-gate review cycle.
function providerCaught(output: ReviewOutput | null, introducingFilenames: Set<string>): boolean {
  if (!output) return false;
  return output.findings.some((f) => f.evidence.some((e) => introducingFilenames.has(e.path)));
}

// --- report formatters -------------------------------------------------------

function findingsMd(findings: ReviewOutput["findings"]): string {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((f) => {
      const loc = f.evidence[0]
        ? `${f.evidence[0].path}:${f.evidence[0].startLine ?? "?"}`
        : "(no location)";
      return `- **${f.title}** (${f.severity}/${f.confidence}) - \`${loc}\`\n  ${f.reasoning.slice(0, 300)}`;
    })
    .join("\n");
}

// --- main --------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const [owner, repo] = args.repo.split("/") as [string, string];

  console.log(`\n[retro-scan-virtuals] ${args.caseId}`);
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
  console.log(`  ${rawFiles.length} files in commit -> ${reviewable.length} reviewable`);

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
      const header = `[OVERSIZE FILE - exceeds ${MAX_FILE_BYTES / 1024}KB; showing unified diff only]\n`;
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
    featureTitle: `${args.label} - introducing commit ${args.prSha.slice(0, 8)}`,
    files: scanFiles.map((f) => ({ path: f.filename, contents: f.contents })),
  });
  const promptSha = createHash("sha256").update(prompt).digest("hex");
  console.log(`  prompt SHA: ${promptSha.slice(0, 16)}...`);

  // 4. Run providers in parallel
  console.log("[3/4] running two-model Virtuals review (60-120s) ...");
  const t0 = Date.now();

  const STACK = [
    { name: "opus-virtuals", modelId: "claude-opus-4-7" },
    { name: "gpt5-virtuals", modelId: "openai-gpt-55" },
  ];

  const client = new VirtualsClient();
  const results: ProviderResult[] = await Promise.all(
    STACK.map(async ({ name, modelId }) => {
      const start = Date.now();
      try {
        const output = await runVirtualsReview(client, modelId, prompt);
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
  const researchDir = join(repoRoot, ".omc/research");
  mkdirSync(researchDir, { recursive: true });

  let pipelineCommitSha = "";
  try {
    pipelineCommitSha = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
  } catch {
    // non-fatal
  }

  const opusVirtualsResult = results.find((r) => r.name === "opus-virtuals");
  const gpt5VirtualsResult = results.find((r) => r.name === "gpt5-virtuals");

  // Evidence JSON - mirrors moonwell-*-evidence.json schema with Virtuals route names.
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
      "apps/web/lib/virtuals-client.ts",
      "apps/web/scripts/run-retro-scan-virtuals.ts",
      "src/spike/build-prompt.ts",
      "src/types.ts",
    ],
    pipelineVersion: "0.1.0",
    pipelineCommitSha,
    modelIds: {
      "opus-virtuals": "claude-opus-4-7",
      "gpt5-virtuals": "openai-gpt-55",
    },
    scannedAt: new Date().toISOString(),
    opusVirtualsRawFindings: opusVirtualsResult?.output?.findings ?? [],
    gpt5VirtualsRawFindings: gpt5VirtualsResult?.output?.findings ?? [],
    opusVirtualsError: opusVirtualsResult?.error ?? null,
    gpt5VirtualsError: gpt5VirtualsResult?.error ?? null,
    outcome,
    outcomeRationale,
  };

  const evidencePath = join(researchDir, `${args.caseId}-virtuals-evidence.json`);
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`  evidence: ${evidencePath}`);

  // Report markdown - mirrors moonwell-*-report.md structure.
  const reportMd = `# Retro scan report - ${args.caseId}

**Outcome:** ${outcome} - ${outcomeRationale}

## Methodology
- Repo: ${args.repo}@${args.prSha}
- Introducing commit: ${args.prSha}
- Prompt SHA: ${promptSha}
- Pipeline version: 0.1.0 @ ${pipelineCommitSha}
- Models: claude-opus-4-7 via Virtuals, openai-gpt-55 via Virtuals
- Scanned at: ${evidence.scannedAt}

## Verdict rationale
${outcomeRationale}

## Per-provider findings (raw)

### Opus via Virtuals (claude-opus-4-7)
${opusVirtualsResult?.error ? `ERROR: ${opusVirtualsResult.error}` : findingsMd(opusVirtualsResult?.output?.findings ?? [])}

### GPT-5 via Virtuals (openai-gpt-55)
${gpt5VirtualsResult?.error ? `ERROR: ${gpt5VirtualsResult.error}` : findingsMd(gpt5VirtualsResult?.output?.findings ?? [])}

## Reproduce this scan
\`\`\`
pnpm exec tsx apps/web/scripts/run-retro-scan-virtuals.ts \\
  --repo ${args.repo} --pr-sha ${args.prSha} \\
  --case-id ${args.caseId} --label "${args.label}" \\
  --loss-usd ${args.lossUsd} --incident-date ${args.incidentDate}
\`\`\`

## Operator decision required
- Outcome A -> publish \`/retro/${args.caseId}\` with "both reviewers caught it" framing
- Outcome B -> publish with "one caught, one didn't - unanimous gate held" framing
- Outcome C -> publish with honest "neither caught it" framing + what we'd change
`;

  const reportPath = join(researchDir, `${args.caseId}-virtuals-report.md`);
  writeFileSync(reportPath, reportMd, "utf8");
  console.log(`  report  : ${reportPath}`);

  console.log(`\n[done] outcome ${outcome}`);
  console.log(reportPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
