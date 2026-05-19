import { Octokit } from "@octokit/rest";
import { createPublicClient, getAddress, http, isAddress, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { logInfo } from "./log";

export type RepoDiscoveryResult = {
  repo: string | null;
  method: "token_uri" | "github_search" | null;
};

export type FactoryLaunchLike = {
  tokenAddress: string;
  tokenName: string | null;
  tokenSymbol: string | null;
};

type RepoRef = { owner: string; repo: string; fullName: string };
type BaseClient = ReturnType<typeof createPublicClient<ReturnType<typeof http>, typeof base>>;

const TOKEN_URI_ABIS = [
  {
    functionName: "tokenURI",
    abi: parseAbi(["function tokenURI(uint256) view returns (string)"]),
    args: [0n],
  },
  {
    functionName: "metadataURI",
    abi: parseAbi(["function metadataURI() view returns (string)"]),
    args: [],
  },
  { functionName: "uri", abi: parseAbi(["function uri() view returns (string)"]), args: [] },
] as const;

const GITHUB_REPO_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i;
const FETCH_TIMEOUT_MS = 5_000;

export async function discoverRepoForAgent(
  launch: FactoryLaunchLike,
): Promise<RepoDiscoveryResult> {
  if (!isAddress(launch.tokenAddress)) {
    throw new Error(`Malformed tokenAddress: ${launch.tokenAddress}`);
  }

  const tokenAddress = getAddress(launch.tokenAddress).toLowerCase() as Address;
  const octokit = makeOctokit();

  logInfo("repo_discovery.attempt", { tokenAddress, method: "token_uri" });
  const tokenUriRepo = await discoverViaTokenUri(tokenAddress, octokit);
  if (tokenUriRepo !== null) {
    logInfo("repo_discovery.hit", { tokenAddress, method: "token_uri", repo: tokenUriRepo });
    return { repo: tokenUriRepo, method: "token_uri" };
  }

  logInfo("repo_discovery.attempt", { tokenAddress, method: "github_search" });
  const searchRepo = await discoverViaGithubSearch(launch, octokit);
  if (searchRepo !== null) {
    logInfo("repo_discovery.hit", { tokenAddress, method: "github_search", repo: searchRepo });
    return { repo: searchRepo, method: "github_search" };
  }

  logInfo("repo_discovery.miss", { tokenAddress, reason: "exhausted" });
  return { repo: null, method: null };
}

function makeOctokit(): Octokit {
  const auth = process.env["ANTFLEET_OPS_GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  return new Octokit(auth === undefined || auth.length === 0 ? {} : { auth });
}

async function discoverViaTokenUri(
  tokenAddress: Address,
  octokit: Octokit,
): Promise<string | null> {
  try {
    const client = createPublicClient({
      chain: base,
      transport: http(process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org"),
    });
    const uri = await readFirstMetadataUri(client, tokenAddress);
    if (uri === null) return null;

    const metadata = await fetchMetadataJson(rewriteIpfsUri(uri));
    const repoRef = repoRefFromMetadata(metadata);
    if (repoRef === null) return null;
    return (await isPublicGithubRepo(octokit, repoRef)) ? repoRef.fullName : null;
  } catch {
    return null;
  }
}

async function readFirstMetadataUri(
  client: BaseClient,
  tokenAddress: Address,
): Promise<string | null> {
  for (const candidate of TOKEN_URI_ABIS) {
    try {
      const value = await client.readContract({
        address: tokenAddress,
        abi: candidate.abi,
        functionName: candidate.functionName,
        args: candidate.args,
      });
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Liquid Protocol tokens are ERC-20s; metadata methods are optional.
    }
  }
  return null;
}

function rewriteIpfsUri(uri: string): string {
  if (!uri.startsWith("ipfs://")) return uri;
  const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
  // ipfs.io is the most common public gateway and is sufficient for read-only discovery.
  return `https://ipfs.io/ipfs/${path}`;
}

async function fetchMetadataJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function repoRefFromMetadata(metadata: unknown): RepoRef | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const repository = record["repository"];
  const candidates = [
    typeof repository === "string" ? repository : null,
    typeof record["repo"] === "string" ? record["repo"] : null,
    repository !== null &&
    typeof repository === "object" &&
    typeof (repository as Record<string, unknown>)["url"] === "string"
      ? ((repository as Record<string, unknown>)["url"] as string)
      : null,
  ];

  for (const candidate of candidates) {
    const repoRef = candidate === null ? null : repoRefFromGithubUrl(candidate);
    if (repoRef !== null) return repoRef;
  }
  return null;
}

function repoRefFromGithubUrl(value: string): RepoRef | null {
  const match = GITHUB_REPO_URL_RE.exec(value.trim());
  if (match === null) return null;
  const owner = match[1] ?? "";
  const repo = match[2] ?? "";
  if (owner.length === 0 || repo.length === 0) return null;
  return { owner, repo, fullName: `${owner}/${repo}`.toLowerCase() };
}

async function isPublicGithubRepo(octokit: Octokit, ref: RepoRef): Promise<boolean> {
  try {
    const response = await octokit.rest.repos.get({ owner: ref.owner, repo: ref.repo });
    return response.data.private === false;
  } catch {
    return false;
  }
}

async function discoverViaGithubSearch(
  launch: FactoryLaunchLike,
  octokit: Octokit,
): Promise<string | null> {
  try {
    const queries = buildSearchQueries(launch);
    if (queries.length === 0) return null;

    const results = await Promise.all(
      queries.map((q) =>
        octokit.rest.search.repos({
          q,
          per_page: 10,
        }),
      ),
    );
    const repos = new Map<string, SearchRepo>();
    for (const response of results) {
      for (const repo of response.data.items) {
        if (isPublicSearchRepo(repo)) repos.set(repo.full_name.toLowerCase(), repo);
      }
    }

    if (repos.size === 1) return [...repos.keys()][0] ?? null;
    if (repos.size === 0) return null;

    const structurallyValid = [];
    for (const repo of repos.values()) {
      if (await passesStructuralCheck(octokit, repo))
        structurallyValid.push(repo.full_name.toLowerCase());
    }
    return structurallyValid.length === 1 ? structurallyValid[0] : null;
  } catch {
    return null;
  }
}

type SearchRepo = {
  full_name: string;
  private: boolean;
  owner: { login: string };
  name: string;
  default_branch: string;
};

function isPublicSearchRepo(repo: {
  full_name?: string;
  private?: boolean;
  owner?: { login?: string } | null;
  name?: string;
  default_branch?: string;
}): repo is SearchRepo {
  return (
    repo.private === false &&
    typeof repo.full_name === "string" &&
    typeof repo.owner?.login === "string" &&
    typeof repo.name === "string" &&
    typeof repo.default_branch === "string"
  );
}

function buildSearchQueries(launch: FactoryLaunchLike): string[] {
  const symbol = normalizedSearchTerm(launch.tokenSymbol);
  const name = normalizedSearchTerm(launch.tokenName);
  const queries = [];
  if (symbol !== null) queries.push(`"${symbol}" liquid agent in:name,description,readme`);
  if (name !== null) queries.push(`"${name}" liquid in:name,description,readme`);
  return queries;
}

function normalizedSearchTerm(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length >= 2 ? trimmed : null;
}

async function passesStructuralCheck(octokit: Octokit, repo: SearchRepo): Promise<boolean> {
  const [readmePasses, treePasses] = await Promise.all([
    readmeMentionsLiquidAgent(octokit, repo),
    rootTreeHasAgentMarkers(octokit, repo),
  ]);
  return readmePasses || treePasses;
}

async function readmeMentionsLiquidAgent(octokit: Octokit, repo: SearchRepo): Promise<boolean> {
  try {
    const response = await octokit.rest.repos.getReadme({
      owner: repo.owner.login,
      repo: repo.name,
    });
    const content = decodeBase64(response.data.content ?? "").toLowerCase();
    return content.includes("liquid") && content.includes("agent");
  } catch {
    return false;
  }
}

async function rootTreeHasAgentMarkers(octokit: Octokit, repo: SearchRepo): Promise<boolean> {
  try {
    const response = await octokit.rest.git.getTree({
      owner: repo.owner.login,
      repo: repo.name,
      tree_sha: repo.default_branch,
      recursive: "false",
    });
    return response.data.tree.some((entry) => {
      const path = entry.path ?? "";
      return /^identity\..+\.json$/i.test(path) || path === "harness" || path === "skills";
    });
  } catch {
    return false;
  }
}

function decodeBase64(value: string): string {
  return Buffer.from(value.replace(/\s/g, ""), "base64").toString("utf8");
}
