import { Octokit } from "@octokit/rest";
import {
  isReviewablePath,
  isWithinSizeLimit,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_TOTAL_PROMPT_BYTES,
  type ChangedFile,
  fetchChangedFilesWith,
} from "./github-files";

export class PublicRepoAccessError extends Error {
  readonly failureModeTag = "user_input";
  readonly errorCode = "repo_not_accessible";
}

export function makePublicOctokit(): Octokit {
  const token = process.env["GITHUB_PUBLIC_TOKEN"];
  return token ? new Octokit({ auth: token }) : new Octokit();
}

export async function getPublicChangedFiles(args: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  octokit?: Octokit;
}): Promise<ChangedFile[]> {
  const octokit = args.octokit ?? makePublicOctokit();
  try {
    return await fetchChangedFilesWith(octokit, args);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 403 || status === 404) {
      throw new PublicRepoAccessError("repository is not publicly accessible");
    }
    throw err;
  }
}

type TreeNode = { path?: string; type?: string; size?: number; sha?: string; mode?: string };

export async function getPublicCommitSnapshotFiles(args: {
  owner: string;
  repo: string;
  sha: string;
  octokit?: Octokit;
}): Promise<ChangedFile[]> {
  const octokit = args.octokit ?? makePublicOctokit();
  try {
    const commit = await octokit.rest.repos.getCommit({
      owner: args.owner,
      repo: args.repo,
      ref: args.sha,
    });
    const headSha = commit.data.sha;
    const tree = await octokit.rest.git.getTree({
      owner: args.owner,
      repo: args.repo,
      tree_sha: headSha,
      recursive: "true",
    });
    const candidates: Array<{ path: string; sha: string; size?: number }> = [];
    for (const node of tree.data.tree ?? []) {
      if (node.type !== "blob") continue;
      if (typeof node.path !== "string" || typeof node.sha !== "string") continue;
      if (!isReviewablePath(node.path)) continue;
      if ((node.size ?? 0) > MAX_FILE_BYTES) continue;
      candidates.push({ path: node.path, sha: node.sha, size: node.size });
      if (candidates.length >= MAX_FILES) break;
    }

    const out: ChangedFile[] = [];
    let totalBytes = 0;
    for (const node of candidates) {
      const resp = await octokit.rest.repos.getContent({
        owner: args.owner,
        repo: args.repo,
        path: node.path,
        ref: headSha,
      });
      const data = resp.data as { type?: string; content?: string };
      if (data.type !== "file" || typeof data.content !== "string") continue;
      const buf = Buffer.from(data.content, "base64");
      if (!isWithinSizeLimit(buf.byteLength)) continue;
      const contents = buf.toString("utf8");
      const chargeBytes = buf.byteLength;
      if (totalBytes + chargeBytes > MAX_TOTAL_PROMPT_BYTES) break;
      totalBytes += chargeBytes;
      out.push({
        filename: node.path,
        contents,
        status: "changed",
        sha: node.sha,
        patch: null,
      });
    }
    return out;
  } catch (err) {
    if (err instanceof PublicRepoAccessError) throw err;
    const status = (err as { status?: number })?.status;
    if (status === 403 || status === 404) {
      throw new PublicRepoAccessError("repository is not publicly accessible");
    }
    throw err;
  }
}
