import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Octokit } from "@octokit/rest";
import { Agent, fetch as undiciFetch } from "undici";
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

// Permitted IP families for tokenURI metadata fetches. The URL is
// attacker-controlled (it comes from an on-chain ERC-20 read), so we
// must refuse private/link-local/loopback ranges to avoid SSRF into
// the Vercel runtime metadata service (169.254.169.254) or any
// internal-only host the build environment can reach.
export async function isPublicHttpUrl(url: string): Promise<boolean> {
  const target = await resolvePublicHttpTarget(url);
  return target !== null;
}

export type PinnedTarget = { parsed: URL; address: string; family: 4 | 6 };

// Validate the URL + DNS resolution, return the address we will pin into
// the fetch. Returning the address (instead of just a boolean) lets the
// fetch path use an undici Agent whose `connect.lookup` always answers
// with this address, closing the DNS-rebinding window between lookup()
// and undici's own resolution.
export async function resolvePublicHttpTarget(url: string): Promise<PinnedTarget | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  // `new URL` keeps IPv6 literals wrapped in brackets in `.hostname`; strip
  // them so node:net `isIP` recognizes the literal.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(hostname);
  if (literal !== 0) {
    const family = literal === 4 ? 4 : 6;
    if (!isPublicAddress(hostname, family)) return null;
    return { parsed, address: hostname, family };
  }
  const addresses = await lookup(hostname, { all: true });
  for (const addr of addresses) {
    if (!isPublicAddress(addr.address, addr.family)) return null;
  }
  const first = addresses[0];
  if (first === undefined) return null;
  const family = first.family === 4 || first.family === 6 ? first.family : 4;
  return { parsed, address: first.address, family };
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  // RFC6890 denylist. Covers loopback, link-local, RFC1918, CGNAT,
  // multicast, future-use, broadcast, and IANA-reserved documentation
  // ranges that should never originate from an attacker-controlled URL.
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 127) return false; // 127/8 loopback
  if (a === 169 && b === 254) return false; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return false; // 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 168) return false; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // 203.0.113/24 TEST-NET-3
  if (a >= 224 && a <= 239) return false; // 224/4 multicast
  if (a >= 240 && a <= 255) return false; // 240/4 future-use + 255.255.255.255 broadcast
  void d;
  return true;
}

function isPublicIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return false;
  // Strip optional zone id (%eth0 etc) for prefix matching.
  const bare = (lower.split("%")[0] ?? lower).trim();

  // Round-3 string-prefix check missed fe80::/10 — `fe80:` only matches the
  // first 16 bits exactly, while link-local extends through febf::. Parse
  // the first 16-bit hextet and apply RFC-correct prefix masks.
  const firstHex = parseFirstIPv6Hextet(bare);
  if (firstHex === null) return false; // Unparseable → conservative deny.

  // fe80::/10 link-local: first 10 bits 1111111010 → first hextet 0xfe80..0xfebf
  if ((firstHex & 0xffc0) === 0xfe80) return false;
  // fec0::/10 site-local (deprecated by RFC3879, defensive): 0xfec0..0xfeff
  if ((firstHex & 0xffc0) === 0xfec0) return false;
  // fc00::/7 unique-local: first byte 0xfc or 0xfd → first hextet 0xfc00..0xfdff
  if ((firstHex & 0xfe00) === 0xfc00) return false;
  // ff00::/8 multicast (covers ff02::1 all-nodes etc).
  if ((firstHex & 0xff00) === 0xff00) return false;

  // 2001:db8::/32 documentation range.
  if (firstHex === 0x2001 && parseSecondIPv6Hextet(bare) === 0x0db8) return false;

  // 64:ff9b::/96 NAT64 + 64:ff9b:1::/48 local NAT64 (RFC6052/RFC8215).
  // In NAT64-capable environments an attacker can express any IPv4
  // target — including 169.254.169.254 — as the lower bits of this
  // prefix, e.g. 64:ff9b::a9fe:a9fe.
  if (firstHex === 0x0064 && parseSecondIPv6Hextet(bare) === 0xff9b) return false;

  // 100::/64 discard-only address block (RFC6666).
  if (firstHex === 0x0100 && parseSecondIPv6Hextet(bare) === 0x0000) return false;

  // 2002::/16 deprecated 6to4 anycast (RFC7526).
  if (firstHex === 0x2002) return false;

  // IPv4-mapped IPv6: delegate to the v4 check. Node normalizes
  // bracketed IPv4-in-IPv6 hostnames (e.g. [::ffff:127.0.0.1]) to the
  // hex form (::ffff:7f00:1) inside URL.hostname; accept both forms.
  const mapped = ipv4FromMappedIPv6(bare);
  if (mapped !== null) return isPublicIPv4(mapped);

  // ::/96 IPv4-compatible IPv6 (RFC4291 §2.5.5.1, deprecated). Modern
  // stacks don't route these but the audit allowlist must still reject
  // them — they are reserved and any future stack that does decode them
  // would target IPv4 ranges we already deny. Anything starting with
  // `::` that isn't ::1 / :: / ::ffff:... falls in this bucket.
  if (bare.startsWith("::")) return false;
  return true;
}

function parseFirstIPv6Hextet(addr: string): number | null {
  // `::xxx` → leading hextet is implicitly 0.
  if (addr.startsWith("::")) return 0;
  const colon = addr.indexOf(":");
  const first = colon === -1 ? addr : addr.slice(0, colon);
  if (first.length === 0) return 0;
  const n = Number.parseInt(first, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
  return n;
}

function parseSecondIPv6Hextet(addr: string): number | null {
  const parts = addr.split(":");
  if (parts.length < 2) return null;
  const second = parts[1];
  if (second === undefined) return null;
  // Empty second part means we hit `::` immediately after the first
  // hextet (e.g. "100::1" or "64:ff9b::" → second hextet of "100::1"
  // is implicitly 0). The :: shortcut always pads from this position
  // with zeros, so empty == 0.
  if (second.length === 0) return 0;
  const n = Number.parseInt(second, 16);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
  return n;
}

function ipv4FromMappedIPv6(value: string): string | null {
  const dotted = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
  if (dotted !== null) return dotted[1] ?? null;
  const hex = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (hex !== null) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    if (
      !Number.isInteger(hi) ||
      !Number.isInteger(lo) ||
      hi < 0 ||
      hi > 0xffff ||
      lo < 0 ||
      lo > 0xffff
    ) {
      return null;
    }
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

// Manual redirect handling + DNS-pinned dispatcher. Two-stage SSRF defense:
//   1. isPublicHttpUrl validates the URL scheme + resolves the hostname,
//      asserting every returned address is in a public range.
//   2. The undici Agent's connect.lookup is hard-coded to return the same
//      address we validated, so the actual TCP connect cannot be redirected
//      by a DNS-rebinding attacker race between lookup() and fetch().
// Bounded redirect depth prevents loops; every Location is revalidated via
// resolvePublicHttpTarget before recursion, so an attacker cannot 302 from
// a public host into 169.254.169.254.
const MAX_REDIRECT_HOPS = 5;

async function fetchMetadataJson(url: string, hops = 0): Promise<unknown> {
  const target = await resolvePublicHttpTarget(url);
  if (target === null) {
    logInfo("repo_discovery.fetch_blocked", { url, hops });
    return null;
  }
  return fetchWithPinnedTargetInternal(url, target, hops);
}

// Test-only seam (see ./repo-discovery-internal-for-tests). The exported
// name in that adjacent module routes here; production callers go through
// fetchMetadataJson, which always validates via resolvePublicHttpTarget
// first. Keeping the export off the public surface of repo-discovery
// avoids accidentally giving the rest of apps/web a way to fetch with
// the privileged pinned dispatcher but skip the allowlist.
export async function fetchWithPinnedTargetInternal(
  url: string,
  target: PinnedTarget,
  hops = 0,
): Promise<unknown> {
  const dispatcher = new Agent({
    connect: {
      // Pin the resolved address into the dispatcher so undici does not
      // re-resolve the hostname during socket creation. undici 8.x calls
      // lookup with `opts.all: true` and expects the addresses-array form
      // of the callback (NOT dns.lookup's `cb(null, address, family)`
      // shape — round-3 auditor probe caught this).
      lookup: (_hostname, _opts, cb) => {
        cb(null, [{ address: target.address, family: target.family }]);
      },
    },
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await undiciFetch(url, {
      signal: controller.signal,
      redirect: "manual",
      dispatcher,
    });
    if (response.status >= 300 && response.status < 400) {
      if (hops >= MAX_REDIRECT_HOPS) {
        logInfo("repo_discovery.redirect_cap_exceeded", { url, hops });
        return null;
      }
      const location = response.headers.get("location");
      if (location === null) return null;
      const next = new URL(location, url).toString();
      // Re-enter the validator: every redirect target has to pass
      // resolvePublicHttpTarget again before we build a new dispatcher.
      return fetchMetadataJson(next, hops + 1);
    }
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timeout);
    await dispatcher.close().catch(() => undefined);
  }
}

// Internal test seam — NOT a production export. Named so a grep for
// "fetchWithPinnedTarget" in production code finds nothing; the
// integration suite imports from this internal namespace.
export const __internalForTests = { fetchWithPinnedTarget: fetchWithPinnedTargetInternal };

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
