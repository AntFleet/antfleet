// Push an AntFleet SARIF export into a GitHub repo's Code Scanning so the
// findings render on the Security tab and on PR shields.
//
// API: POST https://api.github.com/repos/{owner}/{repo}/code-scanning/sarifs
// Docs: https://docs.github.com/en/rest/code-scanning/code-scanning#upload-an-analysis-as-sarif-data
//
// Auth: a personal access token in ANTFLEET_CODESCANNING_PAT with the
// `security_events` scope (classic) or `Security events: Write` (fine-grained).
// We deliberately do NOT use the AntFleet GitHub App installation token —
// the App doesn't request the security_events permission and rolling it
// out would force every install to re-consent. A single AntFleet-owned PAT
// keeps the surface area small for v1.
//
// The payload requires:
//   - `commit_sha`: the SHA the SARIF claims were produced against;
//   - `ref`: the canonical git ref (refs/heads/main typically);
//   - `sarif`: gzip-compressed + base64-encoded SARIF JSON, ≤ 10 MB after
//     the round-trip (GitHub's hard cap).
//
// GitHub responds 202 + { id, url } on accept. We log the id so we can
// poll status later if we want to surface failures back to the worker.
//
// Errors handled here as data (not thrown):
//   - 403 — token missing scope / repo isn't writeable to this PAT;
//   - 404 — repo private and the PAT can't see it;
//   - 422 — SARIF rejected by GitHub's stricter validator.
// The caller logs the structured result and decides whether to surface.

import { gzipSync } from "node:zlib";
import { logError, logInfo, logWarn } from "./log";
import type { SarifLog } from "./sarif-export";

export const GITHUB_CODESCANNING_MAX_BYTES = 10 * 1024 * 1024;

export type CodeScanningPushInput = {
  owner: string;
  repo: string;
  commitSha: string;
  ref: string;
  sarif: SarifLog;
};

export type CodeScanningPushDeps = {
  pat?: string | undefined;
  fetchImpl?: typeof fetch;
  apiBase?: string;
};

export type CodeScanningPushOutcome =
  | { kind: "skipped"; reason: "missing_pat" }
  | { kind: "skipped"; reason: "payload_too_large"; gzipBytes: number }
  | { kind: "accepted"; id: string | null; url: string | null }
  | { kind: "rejected"; status: number; bodyExcerpt: string };

// Push the given SARIF into GitHub Code Scanning. Encodes per spec
// (gzip → base64), enforces the size cap before crossing the network,
// and never throws on auth/validation errors — those are returned as
// structured outcomes for the caller to log.
export async function pushSarifToCodeScanning(
  input: CodeScanningPushInput,
  deps: CodeScanningPushDeps = {},
): Promise<CodeScanningPushOutcome> {
  const pat = deps.pat ?? process.env["ANTFLEET_CODESCANNING_PAT"];
  if (pat === undefined || pat.length === 0) {
    logWarn("codescanning_push.missing_pat", { owner: input.owner, repo: input.repo });
    return { kind: "skipped", reason: "missing_pat" };
  }

  const json = JSON.stringify(input.sarif);
  const gzip = gzipSync(Buffer.from(json, "utf-8"));
  if (gzip.byteLength > GITHUB_CODESCANNING_MAX_BYTES) {
    logWarn("codescanning_push.payload_too_large", {
      owner: input.owner,
      repo: input.repo,
      gzipBytes: gzip.byteLength,
    });
    return { kind: "skipped", reason: "payload_too_large", gzipBytes: gzip.byteLength };
  }
  const encoded = gzip.toString("base64");

  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = deps.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${input.owner}/${input.repo}/code-scanning/sarifs`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        commit_sha: input.commitSha,
        ref: input.ref,
        sarif: encoded,
      }),
    });
  } catch (err) {
    logError("codescanning_push.network_error", {
      owner: input.owner,
      repo: input.repo,
      message: err instanceof Error ? err.message : String(err),
    });
    return { kind: "rejected", status: 0, bodyExcerpt: "network_error" };
  }

  const text = await res.text();
  if (res.status === 202) {
    let id: string | null = null;
    let analysisUrl: string | null = null;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (typeof parsed["id"] === "string") id = parsed["id"];
      if (typeof parsed["url"] === "string") analysisUrl = parsed["url"];
    } catch {
      // GitHub always returns JSON on 202; if it doesn't, treat as
      // accepted-with-no-id rather than an error.
    }
    logInfo("codescanning_push.accepted", {
      owner: input.owner,
      repo: input.repo,
      id,
      gzipBytes: gzip.byteLength,
    });
    return { kind: "accepted", id, url: analysisUrl };
  }

  logWarn("codescanning_push.rejected", {
    owner: input.owner,
    repo: input.repo,
    status: res.status,
    bodyExcerpt: text.slice(0, 240),
  });
  return { kind: "rejected", status: res.status, bodyExcerpt: text.slice(0, 240) };
}
