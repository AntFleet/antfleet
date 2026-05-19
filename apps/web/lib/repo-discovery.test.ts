import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverRepoForAgent } from "./repo-discovery";

const readContract = vi.fn();
const reposGet = vi.fn();
const searchRepos = vi.fn();
const getReadme = vi.fn();
const getTree = vi.fn();

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
  vi.mocked(globalThis.fetch).mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

describe("discoverRepoForAgent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", vi.fn());
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
    expect(globalThis.fetch).toHaveBeenCalledWith(
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
