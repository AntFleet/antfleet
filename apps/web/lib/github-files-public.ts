import { Octokit } from "@octokit/rest";
import { fetchChangedFilesWith, type ChangedFile } from "./github-files";

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
