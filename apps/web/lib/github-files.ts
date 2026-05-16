import { extname } from "node:path";
import { Octokit } from "@octokit/rest";
import { getInstallationToken } from "./github-app";

// Mirrors the spike runner's source-file detection in scripts/spike.ts. Keep
// in sync if that list changes — the review prompt's behavior is tied to it.
const REVIEW_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".json"]);

// AGENTS.md §9: "review changed files only — not whole repo". These caps keep
// any one PR's prompt size within the bounds the spike runs validated. The
// V2/V3 verdicts ran at ~142k-char prompts; this caps us roughly the same.
const MAX_FILE_BYTES = 50 * 1024;
const MAX_FILES = 20;

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

// Filter a raw PR-files list down to what we will review. Pure for testability.
export function filterReviewableFiles<T extends { filename: string; status: string }>(
  files: T[],
): T[] {
  return files
    .filter((f) => f.status !== "removed")
    .filter((f) => REVIEW_EXTENSIONS.has(extname(f.filename)))
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
  const token = await getInstallationToken(args.installationId);
  const octokit = new Octokit({ auth: token });
  return fetchChangedFilesWith(octokit, args);
}
