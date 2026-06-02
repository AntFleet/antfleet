// Repo vulnerability scanner. Fetches a public repo's file tree via the GitHub
// API (no local clone), groups paths by top-level directory, packs them into
// size-bounded chunks (same caps as the PR-review gate), runs the two-model
// review pipeline once per chunk in parallel, and de-duplicates findings across
// chunks. Drives POST /api/v1/scan/x402.
//
// This adapts the chunking logic from scripts/chunk-repo-for-bench.ts — but
// where that script reads a local working tree (readChunkFile → fs.readFile and
// uses the fleet semantic mapper), this works purely from GitHub API data:
// directory grouping from path strings, and file sizes from the tree node
// (so oversized blobs are filtered without ever being fetched).

import {
  isReviewablePath,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_PROMPT_BYTES,
  type ChangedFile,
} from "./github-files";
import { reviewPR as realReviewPR } from "./review-pipeline";
import { findingsAgree, type Finding } from "@antfleet/cli/providers/agreement";
import { logWarn, messageOf } from "./log";

// Hard ceiling on chunks per scan — bounds cost + wall-clock for the synchronous
// endpoint (each chunk is one full two-model review). The route's flat price
// covers up to this many chunks.
const MAX_CHUNKS = 10;
// Max parallel reviewPR calls. Keeps provider concurrency (and the resulting
// burst of API calls) bounded while still finishing 10 chunks well inside the
// route's 300s budget.
const CHUNK_CONCURRENCY = 5;

// Mirrors the ranking agreement.ts uses in pickRepresentative: lower number =
// more important. Kept local so the dedup tiebreak doesn't depend on internals
// agreement.ts does not export.
const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const CONFIDENCE_ORDER: Record<Finding["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

// True when `candidate` should replace `existing` as the representative of an
// agreeing pair: higher severity wins, higher confidence breaks a severity tie.
function outranks(candidate: Finding, existing: Finding): boolean {
  const sev = SEVERITY_ORDER[candidate.severity] - SEVERITY_ORDER[existing.severity];
  if (sev !== 0) return sev < 0;
  return CONFIDENCE_ORDER[candidate.confidence] < CONFIDENCE_ORDER[existing.confidence];
}

export type ScanChunk = {
  chunkIndex: number; // 1-based
  title: string; // e.g. "directory:src chunk 1"
  files: ChangedFile[];
};

export type ScanResult = {
  headSha: string;
  totalFiles: number;
  chunkCount: number;
  skippedChunks: number; // chunks where reviewPR returned degraded
  findings: Finding[]; // de-duplicated across all chunks
  degraded: boolean; // true if ALL chunks were degraded
};

// Minimal structural Octokit surface the scanner touches. Mirrors
// github-files.ts's OctokitMinimal so the real @octokit/rest client and plain
// test stubs both satisfy it without dragging in Octokit's overloaded types.
type TreeNode = { path?: string; type?: string; size?: number; sha?: string };

export type ScanOctokit = {
  rest: {
    repos: {
      get: (params: { owner: string; repo: string }) => Promise<{
        data: { default_branch: string };
      }>;
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }) => Promise<{ data: unknown }>;
    };
    git: {
      getRef: (params: { owner: string; repo: string; ref: string }) => Promise<{
        data: { object: { sha: string } };
      }>;
      getTree: (params: {
        owner: string;
        repo: string;
        tree_sha: string;
        recursive: string;
      }) => Promise<{ data: { tree: TreeNode[] } }>;
    };
  };
};

// A reviewable blob from the tree, with the size + sha we need without a fetch.
type TreeEntry = { path: string; size: number; sha: string };

// A planned chunk before its file contents are fetched.
type ChunkSpec = { title: string; entries: TreeEntry[] };

export async function scanRepo(args: {
  owner: string;
  repo: string;
  octokit: ScanOctokit;
  maxChunks?: number;
  signal?: AbortSignal | null;
  reviewPR?: typeof realReviewPR;
}): Promise<ScanResult> {
  const reviewPR = args.reviewPR ?? realReviewPR;
  const effectiveMaxChunks = Math.min(Math.max(1, args.maxChunks ?? MAX_CHUNKS), MAX_CHUNKS);

  // Step 1 — resolve the default-branch HEAD and fetch the full tree.
  const repoInfo = await args.octokit.rest.repos.get({ owner: args.owner, repo: args.repo });
  const defaultBranch = repoInfo.data.default_branch;
  const headRef = await args.octokit.rest.git.getRef({
    owner: args.owner,
    repo: args.repo,
    ref: `heads/${defaultBranch}`,
  });
  const headSha = headRef.data.object.sha;
  const tree = await args.octokit.rest.git.getTree({
    owner: args.owner,
    repo: args.repo,
    tree_sha: headSha,
    recursive: "true",
  });

  // Step 2 — filter + group + pack into chunk specs.
  const specs = planChunks(tree.data.tree ?? [], effectiveMaxChunks);
  if (specs.length === 0) {
    return {
      headSha,
      totalFiles: 0,
      chunkCount: 0,
      skippedChunks: 0,
      findings: [],
      degraded: false,
    };
  }

  // Step 3 — fetch file contents for each chunk; drop empties.
  const chunks: ScanChunk[] = [];
  for (const spec of specs) {
    const files = await fetchChunkFiles(args.octokit, args.owner, args.repo, headSha, spec.entries);
    if (files.length === 0) continue;
    chunks.push({ chunkIndex: chunks.length + 1, title: spec.title, files });
  }
  if (chunks.length === 0) {
    return {
      headSha,
      totalFiles: 0,
      chunkCount: 0,
      skippedChunks: 0,
      findings: [],
      degraded: false,
    };
  }

  // Step 4 — parallel chunk reviews, concurrency-capped.
  const signal = args.signal ?? undefined;
  const bundles = await limitedParallel(
    chunks.map((chunk) => async () => {
      try {
        return await reviewPR({
          files: chunk.files,
          owner: args.owner,
          repo: args.repo,
          prNumber: 0,
          signal,
        });
      } catch (err) {
        // A single failed chunk degrades that chunk, not the whole scan.
        logWarn("repo_scanner.chunk_review_failed", {
          repo: `${args.owner}/${args.repo}`,
          chunkIndex: chunk.chunkIndex,
          message: messageOf(err),
        });
        return null;
      }
    }),
    CHUNK_CONCURRENCY,
  );

  // Step 5 — aggregate + de-duplicate findings across chunks.
  let skippedChunks = 0;
  const allFindings: Finding[] = [];
  for (const bundle of bundles) {
    if (bundle === null || bundle.degraded) {
      skippedChunks += 1;
      continue;
    }
    allFindings.push(...bundle.agreed);
  }

  // O(n²) dedup — chunk counts are small (<=10). When two findings from
  // different chunks agree (findingsAgree: same category, <=1 severity rank
  // apart, overlapping evidence paths), keep the more severe one — higher
  // confidence breaks a severity tie. Comparing on severity (not first-seen)
  // makes the result independent of chunk order, so the same severe finding is
  // never hidden behind a milder duplicate from an earlier chunk.
  const deduped: Finding[] = [];
  for (const finding of allFindings) {
    const dupIndex = deduped.findIndex((existing) => findingsAgree(existing, finding));
    if (dupIndex === -1) {
      deduped.push(finding);
    } else if (outranks(finding, deduped[dupIndex]!)) {
      deduped[dupIndex] = finding;
    }
  }

  const totalFiles = chunks.reduce((sum, chunk) => sum + chunk.files.length, 0);
  return {
    headSha,
    totalFiles,
    chunkCount: chunks.length,
    skippedChunks,
    findings: deduped,
    degraded: skippedChunks === chunks.length,
  };
}

// Filter tree blobs to reviewable, within-cap files, group by top-level
// directory, and pack each group into size-bounded chunks. Returns at most
// `maxChunks` specs.
export function planChunks(tree: TreeNode[], maxChunks: number): ChunkSpec[] {
  // Cap total nodes considered up front so a giant monorepo never builds an
  // oversized intermediate structure: the most we could ever pack is
  // maxChunks * MAX_FILES files.
  const nodeBudget = maxChunks * MAX_FILES;

  const entries: TreeEntry[] = [];
  for (const node of tree) {
    if (node.type !== "blob" || typeof node.path !== "string") continue;
    if (!isReviewablePath(node.path)) continue;
    // Size comes from the tree node — filter oversized blobs without fetching.
    const size = typeof node.size === "number" ? node.size : 0;
    if (size > MAX_FILE_BYTES) continue;
    entries.push({ path: node.path, size, sha: typeof node.sha === "string" ? node.sha : "" });
  }

  // Sort by (top-level dir, depth, path): keeps each directory's files
  // contiguous, shallowest-first within a directory (fewer "/" = more
  // architecturally significant), deterministic on ties.
  entries.sort((a, b) => {
    const da = topDir(a.path);
    const db = topDir(b.path);
    if (da !== db) return da < db ? -1 : 1;
    const depthA = a.path.split("/").length;
    const depthB = b.path.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const considered = entries.slice(0, nodeBudget);

  // Pack contiguous same-directory runs into chunks; chunk boundaries never
  // cross a directory.
  const specs: ChunkSpec[] = [];
  let i = 0;
  while (i < considered.length && specs.length < maxChunks) {
    const dir = topDir(considered[i]!.path);
    const group: TreeEntry[] = [];
    while (i < considered.length && topDir(considered[i]!.path) === dir) {
      group.push(considered[i]!);
      i += 1;
    }
    for (const chunk of packGroup(dir, group)) {
      if (specs.length >= maxChunks) break;
      specs.push(chunk);
    }
  }
  return specs;
}

// Pack one directory's entries into size-bounded chunks. Mirrors packGroup in
// chunk-repo-for-bench.ts: seal a chunk when adding the next file would exceed
// MAX_FILES or MAX_TOTAL_PROMPT_BYTES. Titled "directory:<dir> chunk <n>".
// Because every surviving file is <= MAX_FILE_BYTES < MAX_TOTAL_PROMPT_BYTES,
// each file always fits in a chunk on its own, so this terminates.
function packGroup(dir: string, entries: TreeEntry[]): ChunkSpec[] {
  const chunks: ChunkSpec[] = [];
  let current: TreeEntry[] = [];
  let currentBytes = 0;
  const seal = (): void => {
    if (current.length > 0) {
      chunks.push({
        title: `directory:${dir} chunk ${chunks.length + 1}`,
        entries: current,
      });
      current = [];
      currentBytes = 0;
    }
  };
  for (const entry of entries) {
    const wouldOverflow =
      current.length >= MAX_FILES || currentBytes + entry.size > MAX_TOTAL_PROMPT_BYTES;
    if (wouldOverflow) seal();
    current.push(entry);
    currentBytes += entry.size;
  }
  seal();
  return chunks;
}

function topDir(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "(root)" : path.slice(0, slash);
}

// Fetch contents for a chunk's entries, building ChangedFile records. Mirrors
// fetchFileContents in roast-runner.ts: drop files that error, aren't a file,
// or aren't base64-encoded. status is synthetic ("added") and patch is null —
// repo scans are file-snapshot reviews with no PR diff to anchor against.
async function fetchChunkFiles(
  octokit: ScanOctokit,
  owner: string,
  repo: string,
  ref: string,
  entries: TreeEntry[],
): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  for (const entry of entries) {
    let data: unknown;
    try {
      const resp = await octokit.rest.repos.getContent({ owner, repo, path: entry.path, ref });
      data = resp.data;
    } catch {
      continue;
    }
    const body = data as { type?: string; content?: string; encoding?: string };
    if (Array.isArray(data) || body.type !== "file" || typeof body.content !== "string") {
      continue;
    }
    if (body.encoding !== undefined && body.encoding !== "base64") continue;
    const buf = Buffer.from(body.content, "base64");
    // Defensive: the tree-node size already filtered oversize blobs, but a
    // racing push could change the file under us. Keep the per-file cap honest.
    if (buf.byteLength > MAX_FILE_BYTES) continue;
    out.push({
      filename: entry.path,
      contents: buf.toString("utf8"),
      status: "added",
      sha: entry.sha,
      patch: null,
    });
  }
  return out;
}

// Run thunks with at most `limit` in flight at once, preserving result order.
async function limitedParallel<T>(thunks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = Array.from<T>({ length: thunks.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= thunks.length) return;
      results[index] = await thunks[index]!();
    }
  };
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
