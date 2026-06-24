import { getInstallationOctokit } from "./github-app";

export class UnexpectedCloneHostError extends Error {
  constructor(host: string, expectedHost: string) {
    super(`resolved clone URL host ${host} does not match expected ${expectedHost}`);
    this.name = "UnexpectedCloneHostError";
  }
}

export type CloneUrlOctokit = {
  rest: {
    repos: {
      get: (args: { owner: string; repo: string }) => Promise<{
        data: {
          clone_url?: string | null;
        };
      }>;
    };
  };
};

export async function resolveInstallRepoCloneUrl(
  args: {
    installationId: number;
    owner: string;
    repo: string;
  },
  octokitFactory: (installationId: number) => Promise<CloneUrlOctokit> = getInstallationOctokit,
): Promise<string> {
  const octokit = await octokitFactory(args.installationId);
  const repo = await octokit.rest.repos.get({ owner: args.owner, repo: args.repo });
  const cloneUrl = repo.data.clone_url;
  if (typeof cloneUrl !== "string" || cloneUrl.length === 0) {
    throw new Error("installation repository clone URL is unavailable");
  }
  assertExpectedGithubCloneHost(cloneUrl);
  return cloneUrl;
}

export function assertExpectedGithubCloneHost(cloneUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    throw new UnexpectedCloneHostError("(invalid)", expectedGithubHost());
  }
  const expectedHost = expectedGithubHost();
  if (parsed.host !== expectedHost) {
    throw new UnexpectedCloneHostError(parsed.host, expectedHost);
  }
}

function expectedGithubHost(): string {
  const serverUrl = process.env["GITHUB_SERVER_URL"];
  if (serverUrl !== undefined && serverUrl.length > 0) return new URL(serverUrl).host;

  const apiUrl = process.env["GITHUB_API_URL"];
  if (apiUrl !== undefined && apiUrl.length > 0) {
    const host = new URL(apiUrl).host;
    return host === "api.github.com" ? "github.com" : host;
  }

  return "github.com";
}
