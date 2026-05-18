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
const MAX_FILE_BYTES = 20 * 1024;
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
};

type PRFileListItem = {
  filename: string;
  status: string;
  // Octokit types sha as nullable for some statuses (e.g. removed); we filter
  // those before reading, but keep the type honest.
  sha: string | null;
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
    if (!isWithinSizeLimit(buf.byteLength)) continue;
    if (totalBytes + buf.byteLength > MAX_TOTAL_PROMPT_BYTES) break;
    totalBytes += buf.byteLength;
    out.push({
      filename: f.filename,
      contents: buf.toString("utf8"),
      status: f.status as ChangedFile["status"],
      sha: f.sha ?? "",
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
