// chunk-repo-for-bench.ts — semantic chunking for large-repo bench onboarding.
//
// "Commit replay" (mirror individual commits as small PRs) is the standard way
// to onboard a repo to the AntFleet bench, but it breaks for repos without
// clean commit history (squash-merged repos, single-giant-initial-commit repos,
// large monorepos). This script clones a source repo, runs the fleet CLI's
// existing semantic feature detection (`mapFeatures`) to group files by logical
// relationship, then opens one PR per feature group in the target bench repo —
// each PR sized to stay within the 150KB review cap.
//
// LOCAL operator CLI. No DB writes, no AntFleet web API, no migrations, no
// Vercel deploy. Resumable: re-running skips chunks that already have a PR, and
// cleans up orphan branches left by a prior partial run so they retry cleanly.
//
// Usage:
//   npx tsx apps/web/scripts/chunk-repo-for-bench.ts \
//     --source <owner/repo>        e.g. aaronjmars/aeon
//     --bench  <owner/bench-repo>  e.g. AntFleet/aeon-bench
//     --token  <github-pat>        PAT with repo write on the bench repo
//     [--dry-run]                  print chunks, create nothing
//     [--max-chunks <n>]           cap PRs created (default: 40)
//     [--clone-dir <path>]         where to clone (default: system tmpdir)
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isReviewablePath,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_PROMPT_BYTES,
} from "../lib/github-files";
import { detectProject } from "@antfleet/cli/detect";
import { mapFeatures } from "@antfleet/cli/mapper";
import type { FeatureRecord } from "@antfleet/cli/types";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "antfleet-chunk-repo-for-bench";
const DEFAULT_MAX_CHUNKS = 40;

export type CliArgs = {
  source: string;
  bench: string;
  token: string;
  dryRun: boolean;
  maxChunks: number;
  cloneDir: string | null;
};

export type ChunkFile = {
  path: string;
  contents: string;
  byteLength: number;
};

export type Chunk = {
  featureId: string;
  featureTitle: string;
  featureKind: string;
  files: ChunkFile[];
};

// A logical grouping of file paths, fed into the size-aware packer. Produced
// either from semantic features or, as a fallback, from top-level directories.
export type FileGroup = {
  id: string;
  title: string;
  kind: string;
  paths: string[];
};

export function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) {
      return undefined;
    }
    const value = argv[index + 1];
    // Guard against `--source --bench` swallowing the next flag as a value.
    if (value === undefined || value.startsWith("--")) {
      return undefined;
    }
    return value;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);

  const source = get("source");
  const bench = get("bench");
  const dryRun = has("dry-run");
  const token = get("token") ?? "";
  const maxChunksRaw = get("max-chunks");
  const cloneDir = get("clone-dir") ?? null;

  const missing: string[] = [];
  if (source === undefined || source.length === 0) missing.push("--source");
  if (bench === undefined || bench.length === 0) missing.push("--bench");
  // --token is only needed when we actually open PRs.
  if (!dryRun && token.length === 0) missing.push("--token (required unless --dry-run)");
  if (missing.length > 0) {
    throw new Error(`Missing required args: ${missing.join(", ")}`);
  }

  let maxChunks = DEFAULT_MAX_CHUNKS;
  if (maxChunksRaw !== undefined) {
    if (!/^\d+$/u.test(maxChunksRaw) || Number.parseInt(maxChunksRaw, 10) <= 0) {
      throw new Error(`--max-chunks must be a positive integer, got "${maxChunksRaw}"`);
    }
    maxChunks = Number.parseInt(maxChunksRaw, 10);
  }

  return {
    source: source as string,
    bench: bench as string,
    token,
    dryRun,
    maxChunks,
    cloneDir,
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/gu, "");
}

// GitHub owner/repo segment charset. Constraining this rejects malformed input
// like "x/.." (which would relocate the clone root) and any value that could be
// misread as a git flag before it reaches execFileSync / the clone URL.
const OWNER_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/u;

export function splitOwnerRepo(value: string): { owner: string; repo: string } {
  const parts = value.split("/");
  const [owner, repo] = parts;
  if (
    parts.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    !OWNER_REPO_SEGMENT.test(owner) ||
    !OWNER_REPO_SEGMENT.test(repo) ||
    owner === ".." ||
    repo === ".."
  ) {
    throw new Error(`Expected <owner/repo> with [A-Za-z0-9._-] segments, got "${value}"`);
  }
  return { owner, repo };
}

// Directories we never descend into during the directory fallback walk. Mirrors
// the fleet detector's ignore set so the fallback stays consistent with the
// semantic mapper's view of the tree.
const SKIP_DIRS = new Set([
  ".build",
  ".fleet",
  ".git",
  ".mypy_cache",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".swiftpm",
  ".venv",
  ".worktrees",
  "Carthage",
  "DerivedData",
  "Pods",
  "SourcePackages",
  "__fixtures__",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "out",
  "target",
  "testdata",
  "venv",
]);

function clone(source: string, baseDir: string): { repoRoot: string; headSha: string } {
  const { repo } = splitOwnerRepo(source);
  const repoRoot = join(baseDir, repo);
  const url = `https://github.com/${source}`;
  console.log(`Cloning ${url} → ${repoRoot}`);
  // Shallow clone: we only read the working tree at HEAD, never history.
  execFileSync("git", ["clone", "--depth", "1", url, repoRoot], { stdio: "inherit" });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  return { repoRoot, headSha };
}

// Read + size-filter a single file. Returns null when unreadable or oversize so
// callers can drop it; logs the reason for oversize skips. Semantic feature
// paths come from the mapper, which does not validate that ownedFiles stay
// inside the repo, so a malicious source repo could surface a "../" path. We
// reject anything that escapes repoRoot before reading — otherwise local files
// (e.g. .env.local) could be read and published into a bench PR.
export function readChunkFile(repoRoot: string, relPath: string): ChunkFile | null {
  const abs = resolve(repoRoot, relPath);
  const rel = relative(repoRoot, abs);
  if (isAbsolute(relPath) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    console.log(`  skipped: path escapes repo root — ${relPath}`);
    return null;
  }
  let contents: string;
  try {
    contents = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const byteLength = Buffer.byteLength(contents, "utf8");
  if (byteLength > MAX_FILE_BYTES) {
    console.log(`  skipped: oversize (${byteLength} bytes > ${MAX_FILE_BYTES}) — ${relPath}`);
    return null;
  }
  return { path: relPath, contents, byteLength };
}

// Pack one group's files into size-bounded chunks. A chunk is sealed when adding
// the next file would exceed MAX_FILES or MAX_TOTAL_PROMPT_BYTES; the overflow
// starts a fresh chunk for the same group. Empty chunks (all files filtered or
// oversize) are dropped. Because MAX_FILE_BYTES < MAX_TOTAL_PROMPT_BYTES, every
// surviving file fits in a chunk on its own, so this always terminates.
export function packGroup(repoRoot: string, group: FileGroup): Chunk[] {
  // Dedup paths first: a feature's ownedFiles can repeat a path (the mapper does
  // not dedup ownedFiles), and two files at the same path in one chunk would
  // make the second contents PUT 422 ("sha wasn't supplied").
  const seen = new Set<string>();
  const uniquePaths = group.paths.filter((path) => {
    if (!isReviewablePath(path) || seen.has(path)) {
      return false;
    }
    seen.add(path);
    return true;
  });
  const reviewable = uniquePaths
    .map((path) => readChunkFile(repoRoot, path))
    .filter((file): file is ChunkFile => file !== null);

  const chunks: Chunk[] = [];
  let current: ChunkFile[] = [];
  let currentBytes = 0;
  const seal = (): void => {
    if (current.length > 0) {
      chunks.push({
        featureId: group.id,
        featureTitle: group.title,
        featureKind: group.kind,
        files: current,
      });
      current = [];
      currentBytes = 0;
    }
  };
  for (const file of reviewable) {
    const wouldOverflow =
      current.length >= MAX_FILES || currentBytes + file.byteLength > MAX_TOTAL_PROMPT_BYTES;
    if (wouldOverflow) {
      seal();
    }
    current.push(file);
    currentBytes += file.byteLength;
  }
  seal();
  return chunks;
}

export function featureGroups(features: FeatureRecord[]): FileGroup[] {
  const sorted = features.toSorted((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind < b.kind ? -1 : 1;
    }
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  return sorted.map((feature) => ({
    id: feature.featureId,
    title: feature.title,
    kind: feature.kind,
    paths: feature.ownedFiles.map((ref) => ref.path),
  }));
}

// Recursively collect reviewable file paths (relative to repoRoot), skipping the
// ignore-set directories and symlinks.
function walkFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const safeReaddir = (dir: string): Dirent[] => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const walk = (dir: string): void => {
    for (const entry of safeReaddir(join(repoRoot, dir))) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const rel = dir.length === 0 ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          continue;
        }
        walk(rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk("");
  return out;
}

// Fallback used only when mapFeatures returns zero features: group every
// reviewable file by its top-level directory and pack each group. Each resulting
// chunk is titled "directory:<dir> chunk <n>".
export function directoryGroups(repoRoot: string): FileGroup[] {
  const byDir = new Map<string, string[]>();
  for (const path of walkFiles(repoRoot)) {
    if (!isReviewablePath(path)) {
      continue;
    }
    const slashIndex = path.indexOf("/");
    const dir = slashIndex === -1 ? "(root)" : path.slice(0, slashIndex);
    const bucket = byDir.get(dir) ?? [];
    bucket.push(path);
    byDir.set(dir, bucket);
  }
  return [...byDir.entries()]
    .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([dir, paths]) => ({
      id: `directory-${dir}`,
      title: `directory:${dir}`,
      kind: "directory",
      paths: paths.toSorted(),
    }));
}

// Expand each group into chunks. For directory-fallback groups (kind
// "directory"), the per-chunk index is appended to the title to match the
// "directory:<dir> chunk <n>" labelling spec.
export function buildChunks(repoRoot: string, groups: FileGroup[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const group of groups) {
    const packed = packGroup(repoRoot, group);
    packed.forEach((chunk, index) => {
      if (group.kind === "directory") {
        chunk.featureTitle = `${group.title} chunk ${index + 1}`;
      }
      chunks.push(chunk);
    });
  }
  return chunks;
}

function totalBytes(chunk: Chunk): number {
  return chunk.files.reduce((sum, file) => sum + file.byteLength, 0);
}

function printDryRun(chunks: Chunk[], source: string, headSha: string): void {
  console.log(`\nDry run — ${chunks.length} chunk(s) for ${source} @ ${headSha.slice(0, 12)}\n`);
  console.log(`${"#".padStart(4)}  ${"files".padStart(5)}  ${"KB".padStart(7)}  feature`);
  console.log("-".repeat(72));
  chunks.forEach((chunk, index) => {
    const kb = (totalBytes(chunk) / 1024).toFixed(1);
    const idx = String(index + 1).padStart(4);
    const files = String(chunk.files.length).padStart(5);
    console.log(
      `${idx}  ${files}  ${kb.padStart(7)}  ${chunk.featureTitle} (${chunk.featureKind})`,
    );
  });
  console.log("-".repeat(72));
  console.log("No PRs created (dry run).");
}

export type GhResponse = { status: number; body: unknown };
// One authenticated GitHub REST call. Injected into the helpers below so tests
// can supply a fake without touching the network.
export type GhRequest = (method: string, path: string, body?: unknown) => Promise<GhResponse>;

// Build the real GitHub request function, bound to a PAT. Retries once on a
// rate-limit response (secondary limits are realistic across a 40-chunk run of
// ref + content + PR writes), honoring Retry-After / the x-ratelimit-reset hint
// before giving up.
function createGhRequest(token: string): GhRequest {
  return async (method, path, body) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${GITHUB_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": USER_AGENT,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
      if (rateLimited && attempt < 2) {
        const waitMs = retryDelayMs(response.headers);
        console.log(`  rate-limited (${response.status}) — waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }
      let parsed: unknown = null;
      const text = await response.text();
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: response.status, body: parsed };
    }
  };
}

// Compute how long to back off from a rate-limited response's headers. Prefers
// Retry-After (seconds), then x-ratelimit-reset (epoch seconds); falls back to
// 60s. Capped at 5 minutes so a bogus header can't hang the run indefinitely.
export function retryDelayMs(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^\d+$/u.test(retryAfter.trim())) {
    return Math.min(Number.parseInt(retryAfter, 10) * 1000, 300_000);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset !== null && /^\d+$/u.test(reset.trim())) {
    const waitMs = Number.parseInt(reset, 10) * 1000 - Date.now();
    if (waitMs > 0) {
      return Math.min(waitMs, 300_000);
    }
  }
  return 60_000;
}

function errorMessage(body: unknown): string {
  if (body !== null && typeof body === "object" && "message" in body) {
    return String((body as { message: unknown }).message);
  }
  return JSON.stringify(body);
}

async function defaultBranch(request: GhRequest, owner: string, repo: string): Promise<string> {
  const res = await request("GET", `/repos/${owner}/${repo}`);
  if (res.status !== 200) {
    throw new Error(
      `GET /repos/${owner}/${repo} failed (${res.status}): ${errorMessage(res.body)}`,
    );
  }
  const body = res.body as { default_branch?: unknown };
  if (typeof body.default_branch !== "string") {
    throw new Error(`Repo ${owner}/${repo} response missing default_branch`);
  }
  return body.default_branch;
}

async function branchHeadSha(
  request: GhRequest,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const res = await request(
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  if (res.status !== 200) {
    throw new Error(`Cannot read base branch ${branch} (${res.status}): ${errorMessage(res.body)}`);
  }
  const body = res.body as { object?: { sha?: unknown } };
  if (typeof body.object?.sha !== "string") {
    throw new Error(`Ref heads/${branch} response missing object.sha`);
  }
  return body.object.sha;
}

async function branchExists(
  request: GhRequest,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const res = await request(
    "GET",
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  return res.status === 200;
}

// Has a PR already been opened from this head branch? This — not mere branch
// existence — is the real "already done" signal: a prior run can leave an orphan
// branch (ref created, then a PUT/PR step failed) that we want to retry, not skip.
async function prExistsForHead(
  request: GhRequest,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const res = await request(
    "GET",
    `/repos/${owner}/${repo}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all&per_page=1`,
  );
  return res.status === 200 && Array.isArray(res.body) && res.body.length > 0;
}

async function deleteBranch(
  request: GhRequest,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  await request("DELETE", `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export type CreateOutcome = "created" | "skipped" | "failed";

export async function createChunkPr(
  request: GhRequest,
  bench: { owner: string; repo: string },
  base: { branch: string; sha: string },
  chunk: Chunk,
  source: string,
  sourceHeadSha: string,
  chunkIndex: number,
  totalChunks: number,
): Promise<CreateOutcome> {
  const slug = slugify(chunk.featureId) || `chunk-${chunkIndex}`;
  const branch = `feat/chunk-${String(chunkIndex).padStart(3, "0")}-${slug}`;

  // Already-done check: skip only when a PR exists for this head. A bare branch
  // with no PR is an orphan from a prior partial run — delete it and retry clean.
  if (await prExistsForHead(request, bench.owner, bench.repo, branch)) {
    console.log(`  skipped: PR already exists for ${branch}`);
    return "skipped";
  }
  if (await branchExists(request, bench.owner, bench.repo, branch)) {
    console.log(`  cleaning orphan branch (no PR) — ${branch}`);
    await deleteBranch(request, bench.owner, bench.repo, branch);
  }

  const createRef = await request("POST", `/repos/${bench.owner}/${bench.repo}/git/refs`, {
    ref: `refs/heads/${branch}`,
    sha: base.sha,
  });
  if (createRef.status !== 201) {
    console.log(
      `  failed: create branch ${branch} (${createRef.status}): ${errorMessage(createRef.body)}`,
    );
    return "failed";
  }

  // Each file is its own commit so the resulting PR diff is navigable.
  for (const file of chunk.files) {
    const put = await request(
      "PUT",
      `/repos/${bench.owner}/${bench.repo}/contents/${encodeContentsPath(file.path)}`,
      {
        message: `feat: add ${file.path}`,
        content: Buffer.from(file.contents, "utf8").toString("base64"),
        branch,
      },
    );
    if (put.status !== 201 && put.status !== 200) {
      console.log(`  warn: PUT ${file.path} failed (${put.status}): ${errorMessage(put.body)}`);
    }
  }

  const pr = await request("POST", `/repos/${bench.owner}/${bench.repo}/pulls`, {
    title: `[chunk ${chunkIndex}/${totalChunks}] ${chunk.featureTitle}`,
    body: prBody(chunk, source, sourceHeadSha, chunkIndex, totalChunks),
    head: branch,
    base: base.branch,
  });
  if (pr.status !== 201) {
    console.log(`  failed: open PR for ${branch} (${pr.status}): ${errorMessage(pr.body)}`);
    // Remove the now-orphaned branch so the next run retries this chunk cleanly
    // instead of treating it as already-done.
    await deleteBranch(request, bench.owner, bench.repo, branch);
    return "failed";
  }
  const prInfo = pr.body as { number?: unknown; html_url?: unknown };
  const prNumber = typeof prInfo.number === "number" ? `#${prInfo.number}` : "(unknown)";
  const prUrl = typeof prInfo.html_url === "string" ? prInfo.html_url : "(no url)";
  console.log(`  PR ${prNumber} created: ${prUrl}`);
  return "created";
}

// The contents API takes the path in the URL; encode each segment but keep the
// slashes that delimit them.
function encodeContentsPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function prBody(
  chunk: Chunk,
  source: string,
  sourceHeadSha: string,
  chunkIndex: number,
  totalChunks: number,
): string {
  const kb = (totalBytes(chunk) / 1024).toFixed(1);
  const fileList = chunk.files.map((file) => `- \`${file.path}\``).join("\n");
  return `## AntFleet bench — semantic chunk ${chunkIndex} of ${totalChunks}

**Source repo:** ${source} @ ${sourceHeadSha}
**Feature:** ${chunk.featureTitle} (${chunk.featureKind})
**Files in this chunk:** ${chunk.files.length} (${kb} KB)

${fileList}

---
*Generated by chunk-repo-for-bench.ts · semantic chunking via fleet mapper*`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bench = splitOwnerRepo(args.bench);

  // When --clone-dir is provided the caller owns it; otherwise we make a fresh
  // tmp dir and remove it on the way out.
  const operatorManagedClone = args.cloneDir !== null;
  const baseDir = operatorManagedClone
    ? (args.cloneDir as string)
    : mkdtempSync(join(tmpdir(), "chunk-repo-"));

  let cleanupDir: string | null = operatorManagedClone ? null : baseDir;
  try {
    const { repoRoot, headSha } = clone(args.source, baseDir);

    console.log("Detecting project + mapping features...");
    const project = await detectProject(repoRoot);
    const { features } = await mapFeatures(repoRoot, project, []);

    let groups: FileGroup[];
    if (features.length === 0) {
      console.log("No semantic features found — falling back to directory chunking.");
      groups = directoryGroups(repoRoot);
    } else {
      console.log(`Mapped ${features.length} feature(s).`);
      groups = featureGroups(features);
    }

    let chunks = buildChunks(repoRoot, groups);
    if (chunks.length === 0) {
      console.log("No reviewable files found — nothing to chunk.");
      return;
    }
    if (chunks.length > args.maxChunks) {
      console.log(`Capping ${chunks.length} chunks to --max-chunks ${args.maxChunks}.`);
      chunks = chunks.slice(0, args.maxChunks);
    }

    if (args.dryRun) {
      printDryRun(chunks, args.source, headSha);
      return;
    }

    const request = createGhRequest(args.token);
    const base = {
      branch: await defaultBranch(request, bench.owner, bench.repo),
      sha: "",
    };
    base.sha = await branchHeadSha(request, bench.owner, bench.repo, base.branch);

    let created = 0;
    let skipped = 0;
    let failed = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunkNumber = index + 1;
      const chunk = chunks[index]!;
      console.log(`\n[${chunkNumber}/${chunks.length}] ${chunk.featureTitle}`);
      let outcome: CreateOutcome;
      try {
        outcome = await createChunkPr(
          request,
          bench,
          base,
          chunk,
          args.source,
          headSha,
          chunkNumber,
          chunks.length,
        );
      } catch (error) {
        console.log(`  failed: ${error instanceof Error ? error.message : String(error)}`);
        outcome = "failed";
      }
      if (outcome === "created") created += 1;
      else if (outcome === "skipped") skipped += 1;
      else failed += 1;
      // Avoid GitHub's secondary rate limit on rapid content/PR writes.
      if (chunkNumber < chunks.length) {
        await sleep(500);
      }
    }

    console.log(`\nCreated ${created} PRs, skipped ${skipped}, failed ${failed}.`);
  } finally {
    if (cleanupDir !== null && existsSync(cleanupDir)) {
      // Defensive: only remove a path we created under tmpdir.
      if (cleanupDir.startsWith(tmpdir() + sep)) {
        try {
          rmSync(cleanupDir, { recursive: true, force: true });
          console.log(`Removed clone dir ${cleanupDir}`);
        } catch (error) {
          console.log(`warn: could not remove ${cleanupDir}: ${String(error)}`);
        }
      }
      cleanupDir = null;
    }
  }
}

function isDirectCliInvocation(): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;
}

if (isDirectCliInvocation()) {
  void main();
}
