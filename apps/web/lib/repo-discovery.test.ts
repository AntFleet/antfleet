import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverRepoForAgent, isPublicHttpUrl } from "./repo-discovery";

const readContract = vi.fn();
const reposGet = vi.fn();
const searchRepos = vi.fn();
const getReadme = vi.fn();
const getTree = vi.fn();
const undiciFetch = vi.fn();

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ readContract })),
  };
});

vi.mock("@octokit/rest", () => ({
  Octokit: class FakeOctokit {
    rest = {
      repos: { get: reposGet, getReadme },
      git: { getTree },
      search: { repos: searchRepos },
    };
  },
}));

vi.mock("undici", () => ({
  Agent: class FakeAgent {
    close() {
      return Promise.resolve();
    }
  },
  fetch: (...args: unknown[]) => undiciFetch(...args),
}));

function launch(overrides: Partial<Parameters<typeof discoverRepoForAgent>[0]> = {}) {
  return {
    tokenAddress: "0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e",
    tokenName: "Autonomopoly",
    tokenSymbol: "AUTONOMOPOLY",
    ...overrides,
  };
}

function repo(fullName: string) {
  const [owner, name] = fullName.split("/");
  return {
    full_name: fullName,
    private: false,
    owner: { login: owner },
    name,
    default_branch: "main",
  };
}

function mockFetchJson(body: unknown) {
  undiciFetch.mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

describe("discoverRepoForAgent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    undiciFetch.mockReset();
    searchRepos.mockResolvedValue({ data: { items: [] } });
    getReadme.mockRejectedValue(new Error("no readme"));
    getTree.mockResolvedValue({ data: { tree: [] } });
  });

  it("discovers via tokenURI with IPFS JSON repository", async () => {
    readContract.mockResolvedValue("ipfs://QmExample/metadata.json");
    mockFetchJson({ repository: "https://github.com/foo/bar" });
    reposGet.mockResolvedValue({ data: { private: false } });

    await expect(discoverRepoForAgent(launch())).resolves.toEqual({
      repo: "foo/bar",
      method: "token_uri",
    });
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://ipfs.io/ipfs/QmExample/metadata.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("discovers via tokenURI with HTTPS repo field", async () => {
    readContract.mockResolvedValue("https://example.com/meta.json");
    mockFetchJson({ repo: "https://github.com/qux/zap" });
    reposGet.mockResolvedValue({ data: { private: false } });

    await expect(discoverRepoForAgent(launch())).resolves.toEqual({
      repo: "qux/zap",
      method: "token_uri",
    });
  });

  it("passes a pinned dispatcher to undici so DNS cannot be re-resolved at connect time", async () => {
    // Regression: round-1 isPublicHttpUrl validated lookup() output but
    // node's global fetch resolved the hostname a second time and could
    // be rebinded onto an internal address between the two resolutions.
    // The fetch path now pins the validated address via undici Agent's
    // connect.lookup hook; verify the dispatcher reaches undici.fetch.
    readContract.mockResolvedValue("https://1.1.1.1/meta");
    mockFetchJson({ repository: "https://github.com/foo/bar" });
    reposGet.mockResolvedValue({ data: { private: false } });

    await discoverRepoForAgent(launch());
    const initArg = undiciFetch.mock.calls[0]?.[1] as { dispatcher?: unknown };
    expect(initArg?.dispatcher).toBeDefined();
  });

  it("blocks tokenURI metadata that 302s into a private address (SSRF redirect)", async () => {
    // Attacker publishes a tokenURI at a public IP that redirects into the
    // Vercel/AWS instance-metadata service. Manual redirect handling +
    // isPublicHttpUrl on the Location target must refuse to follow.
    // Use 1.1.1.1 so the initial allowlist check doesn't depend on DNS.
    readContract.mockResolvedValue("https://1.1.1.1/meta");
    vi.mocked(undiciFetch).mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "http://169.254.169.254/latest/meta-data/" }),
      ok: false,
    } as unknown as Response);

    await expect(discoverRepoForAgent(launch())).resolves.toEqual({
      repo: null,
      method: null,
    });
    // Only the initial fetch should fire; the redirect target is rejected
    // before any second fetch is issued.
    expect(undiciFetch).toHaveBeenCalledTimes(1);
  });

  it("falls through when tokenURI points at a private repo", async () => {
    readContract.mockResolvedValue("https://example.com/meta.json");
    mockFetchJson({ repository: "https://github.com/foo/private-agent" });
    reposGet.mockResolvedValue({ data: { private: true } });
    searchRepos.mockResolvedValue({ data: { items: [] } });

    await expect(discoverRepoForAgent(launch())).resolves.toEqual({
      repo: null,
      method: null,
    });
  });

  it("discovers via github_search when exactly one public repo is found", async () => {
    readContract.mockRejectedValue(new Error("revert"));
    searchRepos.mockResolvedValueOnce({ data: { items: [repo("Foo/Agent-One")] } });
    searchRepos.mockResolvedValueOnce({ data: { items: [] } });

    await expect(
      discoverRepoForAgent(launch({ tokenName: "Agent One", tokenSymbol: "ONE" })),
    ).resolves.toEqual({
      repo: "foo/agent-one",
      method: "github_search",
    });
  });

  it("returns null when github_search has multiple structurally valid repos", async () => {
    readContract.mockRejectedValue(new Error("revert"));
    searchRepos.mockResolvedValueOnce({ data: { items: [repo("Foo/Agent-One")] } });
    searchRepos.mockResolvedValueOnce({ data: { items: [repo("Bar/Agent-Two")] } });
    getReadme.mockImplementation(({ owner }: { owner: string }) =>
      Promise.resolve({
        data: {
          content: Buffer.from(`${owner} liquid agent`).toString("base64"),
        },
      }),
    );

    await expect(
      discoverRepoForAgent(launch({ tokenName: "Agent", tokenSymbol: "AG" })),
    ).resolves.toEqual({
      repo: null,
      method: null,
    });
  });

  it("discovers the autonomopoly fixture shape", async () => {
    readContract.mockRejectedValue(new Error("revert"));
    searchRepos.mockResolvedValueOnce({
      data: { items: [repo("Liquid-Protocol-Ops/agent-autonomopoly")] },
    });
    searchRepos.mockResolvedValueOnce({ data: { items: [] } });

    await expect(
      discoverRepoForAgent(launch({ tokenName: "Autonomopoly", tokenSymbol: "AUTONOMOPOLY" })),
    ).resolves.toEqual({
      repo: "liquid-protocol-ops/agent-autonomopoly",
      method: "github_search",
    });
  });
});

describe("isPublicHttpUrl (SSRF allowlist for tokenURI fetch)", () => {
  it("rejects the AWS/Vercel instance metadata service", async () => {
    expect(await isPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("rejects loopback", async () => {
    expect(await isPublicHttpUrl("http://127.0.0.1/")).toBe(false);
    expect(await isPublicHttpUrl("http://[::1]/")).toBe(false);
  });

  it("rejects RFC1918 private ranges", async () => {
    expect(await isPublicHttpUrl("http://10.0.0.1/foo")).toBe(false);
    expect(await isPublicHttpUrl("http://172.16.0.1/foo")).toBe(false);
    expect(await isPublicHttpUrl("http://192.168.1.1/foo")).toBe(false);
  });

  it("rejects non-http(s) schemes", async () => {
    expect(await isPublicHttpUrl("file:///etc/passwd")).toBe(false);
    expect(await isPublicHttpUrl("gopher://1.2.3.4/")).toBe(false);
    expect(await isPublicHttpUrl("ipfs://bafy/")).toBe(false);
  });

  it("rejects malformed URLs", async () => {
    expect(await isPublicHttpUrl("not a url")).toBe(false);
  });

  it("rejects fc00::/7 unique-local IPv6", async () => {
    expect(await isPublicHttpUrl("http://[fc00::1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[fd00::1]/")).toBe(false);
  });

  it("rejects the FULL fe80::/10 link-local range (not just fe80::)", async () => {
    // Regression: round-4 audit probe found fe90, febf, fec0 all returned
    // true under the old `lower.startsWith('fe80:')` check.
    expect(await isPublicHttpUrl("http://[fe80::1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[fe90::1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[febf::1]/")).toBe(false);
  });

  it("rejects fec0::/10 deprecated site-local", async () => {
    expect(await isPublicHttpUrl("http://[fec0::1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[feff::1]/")).toBe(false);
  });

  it("rejects ff00::/8 IPv6 multicast", async () => {
    expect(await isPublicHttpUrl("http://[ff02::1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[ff00::1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[ffff::1]/")).toBe(false);
  });

  it("rejects 2001:db8::/32 documentation range", async () => {
    expect(await isPublicHttpUrl("http://[2001:db8::1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[2001:0db8::1]/")).toBe(false);
  });

  it("permits a global-unicast IPv6 literal", async () => {
    // 2001:4860:4860::8888 is one of Google's public DNS servers — a
    // canonical public IPv6.
    expect(await isPublicHttpUrl("http://[2001:4860:4860::8888]/")).toBe(true);
  });

  it("rejects IPv4-mapped IPv6 pointing at loopback (dotted + hex)", async () => {
    // node URL normalizes [::ffff:127.0.0.1] to [::ffff:7f00:1]; both shapes
    // must denylist via the IPv4 path.
    expect(await isPublicHttpUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[::ffff:7f00:1]/")).toBe(false);
    expect(await isPublicHttpUrl("http://[::ffff:169.254.169.254]/")).toBe(false);
  });

  it("rejects 100.64/10 CGNAT", async () => {
    expect(await isPublicHttpUrl("http://100.64.0.1/")).toBe(false);
    expect(await isPublicHttpUrl("http://100.127.255.255/")).toBe(false);
  });

  it("rejects 198.18/15 benchmarking range", async () => {
    expect(await isPublicHttpUrl("http://198.18.0.1/")).toBe(false);
    expect(await isPublicHttpUrl("http://198.19.255.254/")).toBe(false);
  });

  it("rejects IANA TEST-NET documentation ranges", async () => {
    expect(await isPublicHttpUrl("http://192.0.2.1/")).toBe(false);
    expect(await isPublicHttpUrl("http://198.51.100.1/")).toBe(false);
    expect(await isPublicHttpUrl("http://203.0.113.1/")).toBe(false);
  });

  it("rejects 224/4 multicast and 240/4 future-use + broadcast", async () => {
    expect(await isPublicHttpUrl("http://224.0.0.1/")).toBe(false);
    expect(await isPublicHttpUrl("http://239.255.255.250/")).toBe(false);
    expect(await isPublicHttpUrl("http://240.0.0.1/")).toBe(false);
    expect(await isPublicHttpUrl("http://255.255.255.255/")).toBe(false);
  });

  it("permits public IPv4 literals (e.g. an ipfs.io address)", async () => {
    // 1.1.1.1 is Cloudflare DNS — a well-known public IPv4; the helper
    // must let unrelated public addresses through.
    expect(await isPublicHttpUrl("https://1.1.1.1/")).toBe(true);
  });

  it("permits a normal ipfs.io URL after dns resolution", async () => {
    // Real DNS lookup; ipfs.io must resolve to a public address.
    expect(
      await isPublicHttpUrl(
        "https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy",
      ),
    ).toBe(true);
  });
});
