import { getInstallationOctokit } from "@/lib/github-app";
import { redactSecrets } from "@/lib/disagreements";
import type { Octokit } from "@octokit/rest";

export type HunkPair = {
  vulnerable: { content: string; commitSha: string } | null;
  fix: { content: string; commitSha: string } | null;
};

export type FetchHunkPairArgs = {
  owner: string;
  repo: string;
  installationId: number;
  prSha: string;
  closureSha: string;
  file: string;
  lineStart: number;
  lineEnd: number;
};

type OctokitFactory = (installationId: number) => Promise<Octokit>;

export async function fetchHunkPair(
  args: FetchHunkPairArgs,
  octokitFactory: OctokitFactory = getInstallationOctokit,
): Promise<HunkPair | null> {
  if (args.owner.length === 0 || args.repo.length === 0 || args.file.length === 0) {
    return null;
  }

  try {
    const octokit = await octokitFactory(args.installationId);
    const [vulnerable, fix] = await Promise.allSettled([
      fetchFileSlice(octokit, args.owner, args.repo, args.file, args.prSha, args.lineStart, args.lineEnd),
      fetchFileSlice(octokit, args.owner, args.repo, args.file, args.closureSha, args.lineStart, args.lineEnd),
    ]);

    return {
      vulnerable: vulnerable.status === "fulfilled" ? vulnerable.value : null,
      fix: fix.status === "fulfilled" ? fix.value : null,
    };
  } catch {
    return null;
  }
}

async function fetchFileSlice(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  lineStart: number,
  lineEnd: number,
): Promise<{ content: string; commitSha: string }> {
  const response = await octokit.rest.repos.getContent({ owner, repo, path, ref });
  const data = response.data;

  if (Array.isArray(data) || !("content" in data) || typeof data.content !== "string") {
    throw new Error("unexpected response shape");
  }

  const fullContent = Buffer.from(data.content, "base64").toString("utf-8");
  const lines = fullContent.split("\n");

  const start = Math.max(0, lineStart - 1);
  const end = lineEnd > 0 ? lineEnd : lines.length;
  const slice = lines.slice(start, end).join("\n");

  return {
    content: redactSecrets(slice),
    commitSha: ref,
  };
}
