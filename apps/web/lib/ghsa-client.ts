import { logInfo } from "./log";

export type GhsaSeverity = "low" | "medium" | "high" | "critical";

export type GhsaAdvisoryInput = {
  owner: string;
  repo: string;
  summary: string;
  description: string;
  idempotencyMarker?: string;
  severity: GhsaSeverity;
  affectedPackageName: string;
  vulnerableVersionRange: string;
  patchedVersions: string | null;
  cvssVectorString?: string | null;
};

export type GhsaDraft = {
  ghsaId: string;
  cveId: string | null;
  htmlUrl: string | null;
};

export type GhsaPublication = {
  published: boolean;
  htmlUrl: string | null;
  mock: boolean;
};

export type GhsaClient = {
  createDraftAdvisory(input: GhsaAdvisoryInput): Promise<GhsaDraft>;
  requestCve(owner: string, repo: string, ghsaId: string): Promise<GhsaDraft>;
  publishAdvisory(owner: string, repo: string, ghsaId: string): Promise<GhsaPublication>;
};

class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function token(): string {
  const value = process.env["ANTFLEET_OPS_GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (value === undefined || value.length === 0) {
    throw new Error("ANTFLEET_OPS_GH_TOKEN or GITHUB_TOKEN is required for GHSA API calls");
  }
  return value;
}

function apiBase(): string {
  return process.env["GITHUB_API_URL"] ?? "https://api.github.com";
}

function mockMode(): boolean {
  const raw = process.env["ANTFLEET_GHSA_MOCK"];
  return raw === "true" || raw === "1" || raw === "yes";
}

function assertMockAllowed(): void {
  const explicitlyAllowed = process.env["ANTFLEET_ALLOW_GHSA_MOCK"] === "true";
  const runtime = process.env["NODE_ENV"] ?? "";
  const vercelEnv = process.env["VERCEL_ENV"] ?? "";
  if (
    explicitlyAllowed ||
    runtime === "test" ||
    runtime === "development" ||
    vercelEnv === "preview" ||
    vercelEnv === "development"
  ) {
    return;
  }
  throw new Error("ANTFLEET_GHSA_MOCK is only allowed in test, development, or preview runtimes");
}

async function githubJsonResponse<T>(
  path: string,
  init: RequestInit,
): Promise<{ data: T; link: string | null }> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init.headers,
    },
  });
  if (!res.ok) {
    const requestId = res.headers.get("x-github-request-id");
    throw new GitHubApiError(
      `GitHub API ${init.method ?? "GET"} ${path} failed: ${res.status}${
        requestId === null ? "" : ` request_id=${requestId}`
      }`,
      res.status,
    );
  }
  const text = await res.text();
  return {
    data: (text.length === 0 ? null : JSON.parse(text)) as T,
    link: res.headers.get("link"),
  };
}

async function githubJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await githubJsonResponse<T>(path, init);
  return response.data;
}

async function githubJsonOrNull<T>(path: string, init: RequestInit): Promise<T | null> {
  try {
    return await githubJson<T>(path, init);
  } catch {
    return null;
  }
}

function securityAdvisoryPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/security-advisories`;
}

export const ghsaClient: GhsaClient = {
  async createDraftAdvisory(input): Promise<GhsaDraft> {
    if (mockMode()) {
      assertMockAllowed();
      const ghsaId = `GHSA-mock-${input.owner.toLowerCase()}-${input.repo.toLowerCase()}`;
      logInfo("ghsa.mock_create", { owner: input.owner, repo: input.repo, ghsaId });
      return { ghsaId, cveId: null, htmlUrl: null };
    }
    const existing = await findExistingDraft(input);
    if (existing !== null) {
      logInfo("ghsa.reuse_existing", {
        owner: input.owner,
        repo: input.repo,
        ghsaId: existing.ghsaId,
      });
      return existing;
    }
    const body = {
      summary: input.summary,
      description: input.description,
      severity: input.severity,
      vulnerabilities: [
        {
          package: {
            ecosystem: "other",
            name: input.affectedPackageName,
          },
          vulnerable_version_range: input.vulnerableVersionRange,
          patched_versions: input.patchedVersions,
        },
      ],
      ...(input.cvssVectorString !== undefined && input.cvssVectorString !== null
        ? { cvss_vector_string: input.cvssVectorString }
        : {}),
      cve_id: null,
    };
    let response: {
      ghsa_id: string;
      cve_id?: string | null;
      html_url?: string | null;
    };
    try {
      response = await githubJson<{
        ghsa_id: string;
        cve_id?: string | null;
        html_url?: string | null;
      }>(securityAdvisoryPath(input.owner, input.repo), {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
      const racedExisting = await findExistingDraft(input);
      if (racedExisting === null) throw err;
      logInfo("ghsa.reuse_raced_existing", {
        owner: input.owner,
        repo: input.repo,
        ghsaId: racedExisting.ghsaId,
      });
      return racedExisting;
    }
    return {
      ghsaId: response.ghsa_id,
      cveId: response.cve_id ?? null,
      htmlUrl: response.html_url ?? null,
    };
  },

  async requestCve(owner, repo, ghsaId): Promise<GhsaDraft> {
    if (mockMode()) {
      assertMockAllowed();
      logInfo("ghsa.mock_request_cve", { owner, repo, ghsaId });
      return { ghsaId, cveId: null, htmlUrl: null };
    }
    try {
      await githubJson<unknown>(`${securityAdvisoryPath(owner, repo)}/${ghsaId}/cve`, {
        method: "POST",
        body: "{}",
      });
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
      logInfo("ghsa.cve_request_already_submitted", { owner, repo, ghsaId });
    }
    return await loadAdvisory(owner, repo, ghsaId);
  },

  async publishAdvisory(owner, repo, ghsaId): Promise<GhsaPublication> {
    if (mockMode()) {
      assertMockAllowed();
      logInfo("ghsa.mock_publish", { owner, repo, ghsaId });
      return { published: false, htmlUrl: null, mock: true };
    }
    const path = `${securityAdvisoryPath(owner, repo)}/${ghsaId}`;
    const existing = await githubJson<{ state?: string | null; html_url?: string | null }>(path, {
      method: "GET",
    });
    if (existing.state === "published") {
      return { published: true, htmlUrl: existing.html_url ?? null, mock: false };
    }
    try {
      await githubJson<unknown>(path, {
        method: "PATCH",
        body: JSON.stringify({ state: "published" }),
      });
    } catch (err) {
      const refreshed = await githubJsonOrNull<{ state?: string | null; html_url?: string | null }>(
        path,
        { method: "GET" },
      );
      if (refreshed?.state === "published") {
        return { published: true, htmlUrl: refreshed.html_url ?? null, mock: false };
      }
      throw err;
    }
    const published = await githubJson<{ state?: string | null; html_url?: string | null }>(path, {
      method: "GET",
    });
    return {
      published: published.state === "published",
      htmlUrl: published.html_url ?? null,
      mock: false,
    };
  },
};

async function loadAdvisory(owner: string, repo: string, ghsaId: string): Promise<GhsaDraft> {
  const advisory = await githubJson<{
    ghsa_id: string;
    cve_id?: string | null;
    html_url?: string | null;
  }>(`${securityAdvisoryPath(owner, repo)}/${ghsaId}`, { method: "GET" });
  return {
    ghsaId: advisory.ghsa_id,
    cveId: advisory.cve_id ?? null,
    htmlUrl: advisory.html_url ?? null,
  };
}

async function findExistingDraft(input: GhsaAdvisoryInput): Promise<GhsaDraft | null> {
  const marker = input.idempotencyMarker;
  if (marker === undefined || marker.length === 0) return null;
  let path: string | null = `${securityAdvisoryPath(input.owner, input.repo)}?per_page=100`;
  while (path !== null) {
    const response = await githubJsonResponse<
      Array<{
        ghsa_id: string;
        cve_id?: string | null;
        html_url?: string | null;
        description?: string | null;
      }>
    >(path, { method: "GET" });
    const matched = response.data.find(
      (advisory) => advisory.description?.includes(marker) === true,
    );
    if (matched !== undefined) {
      return {
        ghsaId: matched.ghsa_id,
        cveId: matched.cve_id ?? null,
        htmlUrl: matched.html_url ?? null,
      };
    }
    path = nextPagePath(response.link);
  }
  return null;
}

function nextPagePath(linkHeader: string | null): string | null {
  if (linkHeader === null) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1] === undefined) continue;
    const url = new URL(match[1]);
    return `${url.pathname}${url.search}`;
  }
  return null;
}
