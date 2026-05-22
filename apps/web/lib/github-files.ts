import { basename, extname } from "node:path";
import { getInstallationOctokit } from "./github-app";

// Mirrors the spike runner's source-file detection in scripts/spike.ts. Keep
// in sync if that list changes — the review prompt's behavior is tied to it.
// Expanded beyond pure-JS/TS to cover the file types where agent repos keep
// their load-bearing content (.md identity/wiki, .yml CI + agent definitions,
// .toml config, .sh scripts) plus broader-ecosystem source (.rs, .go, .py,
// .sol). Generated files in the same extensions are filtered by the
// blocklist below, not by removing the extension here.
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

// Files we never review regardless of extension. Matched against the PR
// file's basename (last path segment). Lockfiles + license + ignore manifests
// blow up the prompt without producing useful findings.
export const REVIEW_BLOCKLIST_BASENAMES = new Set([
  ".gitignore",
  ".npmignore",
  ".prettierignore",
  "Cargo.lock",
  "COPYING",
  "Gemfile.lock",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "Pipfile.lock",
  "bun.lockb",
  "composer.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

// Path-suffix patterns that mark generated / vendored / minified output.
// Matched as plain substring against the full filename (relative to repo
// root) — kept as suffix tests since these are deterministic markers, not
// regexes.
export const REVIEW_BLOCKLIST_PATH_SUFFIXES = [
  "/.next/",
  "/.vercel/",
  "/build/",
  "/coverage/",
  "/dist/",
  "/node_modules/",
  "/out/",
  ".gen.go",
  ".gen.ts",
  ".generated.js",
  ".generated.ts",
  ".min.css",
  ".min.js",
  ".pb.go",
  ".pb.ts",
];

// AGENTS.md §9: "review changed files only — not whole repo". These caps keep
// any one PR's prompt size within the V2/V3-validated zone (~142k-char
// corpus). Slice 4b's first smoke at 20 files × 50KB triggered anthropic
// tool_use truncation on the larger prompt; slice 4b.1 tightens the budget.
//
// MAX_FILE_BYTES raised from 20KB → 80KB on 2026-05-21 after observing
// monolithic GHA workflows in agent-framework repos (aeon.yml at 45KB,
// README at 29KB) silently slipping through the gate with
// "no reviewable files". Files above the cap now fall back to the PR's
// unified diff (see fetchChangedFilesWith) instead of being dropped.
const MAX_FILE_BYTES = 80 * 1024;
const MAX_FILES = 15;
// Hard ceiling on the combined size of file contents going into the prompt.
// Roughly tracks spike's empirically-tested corpus size with headroom for
// the prompt scaffolding and per-file `--- path\n` separators.
const MAX_TOTAL_PROMPT_BYTES = 150 * 1024;

export type ChangedFile = {
  filename: string;
  contents: string;
  status: "added" | "modified" | "renamed" | "copied" | "changed";
  sha: string;
  // Patch Agent v1.5 — unified diff for this file as GitHub returned it on
  // listFiles. Retained on every entry (not just the oversize-fallback path)
  // so the diff-hunk filter can decide whether a proposed patch lands
  // inside a changed region. Null for binary files and very large files
  // where GitHub omits `patch`.
  patch: string | null;
};

type PRFileListItem = {
  filename: string;
  status: string;
  // Octokit types sha as nullable for some statuses (e.g. removed); we filter
  // those before reading, but keep the type honest.
  sha: string | null;
  // Unified diff for the file. GitHub omits `patch` for binary files and
  // sometimes for very large files; we treat both cases the same.
  patch?: string | null;
};

type FileContentBody = {
  type?: string;
  content?: string;
};

// Predicate split out so tests can hit it directly. Path-only — does not
// look at file status. True when the path's extension is in the allow set
// AND neither its basename nor any path segment matches the blocklists.
export function isReviewablePath(filename: string): boolean {
  if (filename.length === 0) return false;
  if (!REVIEW_EXTENSIONS.has(extname(filename))) return false;
  if (REVIEW_BLOCKLIST_BASENAMES.has(basename(filename))) return false;
  for (const suffix of REVIEW_BLOCKLIST_PATH_SUFFIXES) {
    if (filename.includes(suffix)) return false;
  }
  return true;
}

// Filter a raw PR-files list down to what we will review. Pure for testability.
export function filterReviewableFiles<T extends { filename: string; status: string }>(
  files: T[],
): T[] {
  return files
    .filter((f) => f.status !== "removed")
    .filter((f) => isReviewablePath(f.filename))
    .slice(0, MAX_FILES);
}

export function isWithinSizeLimit(bytes: number): boolean {
  return bytes <= MAX_FILE_BYTES;
}

// Narrow Octokit surface used here. Structural-only so the real Octokit
// (which has extra `defaults`/`endpoint` props) and plain-function test mocks
// both satisfy it. We only ever read `.data` off the response.
export type OctokitMinimal = {
  rest: {
    pulls: {
      listFiles: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }) => Promise<{ data: PRFileListItem[] }>;
    };
    repos: {
      getContent: (params: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }) => Promise<{ data: unknown }>;
    };
  };
};

// Internal: split for unit testing. Takes a pre-authed Octokit so tests can
// inject a stub.
export async function fetchChangedFilesWith(
  octokit: OctokitMinimal,
  args: { owner: string; repo: string; prNumber: number; headSha: string },
): Promise<ChangedFile[]> {
  const list = await octokit.rest.pulls.listFiles({
    owner: args.owner,
    repo: args.repo,
    pull_number: args.prNumber,
    per_page: 100,
  });
  const reviewable = filterReviewableFiles(list.data as PRFileListItem[]);
  const out: ChangedFile[] = [];
  let totalBytes = 0;
  for (const f of reviewable) {
    const resp = await octokit.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: f.filename,
      ref: args.headSha,
    });
    const data = resp.data as FileContentBody | unknown[];
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      continue;
    }
    const buf = Buffer.from(data.content, "base64");
    let contents: string;
    let chargeBytes: number;
    if (isWithinSizeLimit(buf.byteLength)) {
      contents = buf.toString("utf8");
      chargeBytes = buf.byteLength;
    } else {
      // File exceeds MAX_FILE_BYTES — fall back to the PR's unified diff for
      // this file so the reviewer still sees the actual changes. The header
      // tells the reviewer the context is partial.
      const patch = f.patch;
      if (typeof patch !== "string" || patch.length === 0) continue;
      const header =
        `[OVERSIZE FILE — original ${buf.byteLength} bytes ` +
        `exceeds ${MAX_FILE_BYTES / 1024}KB per-file review cap; ` +
        `showing unified diff only]\n`;
      const body = header + patch;
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (bodyBytes > MAX_FILE_BYTES) continue;
      contents = body;
      chargeBytes = bodyBytes;
    }
    if (totalBytes + chargeBytes > MAX_TOTAL_PROMPT_BYTES) break;
    totalBytes += chargeBytes;
    out.push({
      filename: f.filename,
      contents,
      status: f.status as ChangedFile["status"],
      sha: f.sha ?? "",
      patch: typeof f.patch === "string" ? f.patch : null,
    });
  }
  return out;
}

// Top-level entry: auth via App installation + delegate to fetchChangedFilesWith.
export async function getChangedFiles(args: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}): Promise<ChangedFile[]> {
  const octokit = await getInstallationOctokit(args.installationId);
  return fetchChangedFilesWith(octokit, args);
}

// Patch Agent v1.5 — single-file fetcher used by the sweeper's patch-
// acceptance pass. Unlike fetchChangedFilesWith (which iterates a PR's
// listFiles), this reads ONE file at a specific ref (e.g. "main" HEAD
// after a merge). Returns null when the file is missing, binary, or
// over the size cap — the pass treats null as "no match" rather than
// throwing, so a single broken read can't crash the sweep tick.
export async function fetchFileAtRefWith(
  octokit: OctokitMinimal,
  args: { owner: string; repo: string; path: string; ref: string },
): Promise<string | null> {
  try {
    const resp = await octokit.rest.repos.getContent({
      owner: args.owner,
      repo: args.repo,
      path: args.path,
      ref: args.ref,
    });
    const data = resp.data as FileContentBody | unknown[];
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") {
      return null;
    }
    const buf = Buffer.from(data.content, "base64");
    if (!isWithinSizeLimit(buf.byteLength)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export async function fetchFileAtRef(args: {
  installationId: number;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<string | null> {
  const octokit = await getInstallationOctokit(args.installationId);
  return fetchFileAtRefWith(octokit, args);
}
