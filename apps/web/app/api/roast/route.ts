import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { nanoid } from "nanoid";
import { z } from "zod";
import { logError, logInfo, logWarn } from "@/lib/log";
import { isPublicRepo } from "@/lib/repo-visibility";
import {
  countRecentRoastSubmissionsByIp,
  countRecentRoastSubmissionsByRepo,
  insertRoastSubmission,
} from "@/lib/roast-intake";

// node:crypto + DB driver are Node-only; lock this route off the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPO_SIZE_KB = 512000;

const roastBodySchema = z.object({
  repoUrl: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/iu),
  submitterHandle: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/u)
    .optional(),
  submitterEmail: z.string().email().optional(),
});

type RoastBody = z.infer<typeof roastBodySchema>;

type RoastOctokit = {
  rest: {
    repos: {
      get: (params: { owner: string; repo: string }) => Promise<{
        data: {
          private: boolean;
          size: number;
        };
      }>;
    };
  };
};

export type RoastDeps = {
  createSubmissionId: () => string;
  createOctokit: () => RoastOctokit;
  isPublicRepo: typeof isPublicRepo;
  countRecentByIp: typeof countRecentRoastSubmissionsByIp;
  countRecentByRepo: typeof countRecentRoastSubmissionsByRepo;
  insertSubmission: typeof insertRoastSubmission;
};

const DEFAULT_DEPS: RoastDeps = {
  createSubmissionId: nanoid,
  createOctokit: () =>
    new Octokit({
      // ROAST_GH_TOKEN is optional; when set it raises GitHub's unauthenticated 60-req/hr limit.
      auth: process.env["ROAST_GH_TOKEN"] ?? undefined,
      userAgent: "antfleet-roast-intake",
    }),
  isPublicRepo,
  countRecentByIp: countRecentRoastSubmissionsByIp,
  countRecentByRepo: countRecentRoastSubmissionsByRepo,
  insertSubmission: insertRoastSubmission,
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handleRoast(req, DEFAULT_DEPS);
}

export async function handleRoast(req: NextRequest, deps: RoastDeps): Promise<NextResponse> {
  try {
    const body = await readJson(req);
    const parsed = roastBodySchema.safeParse(body);

    if (!parsed.success) {
      logWarn("roast.invalid_input", { issues: parsed.error.issues });
      return jsonResponse(400, {
        error: "invalid-input",
        issues: parsed.error.issues,
      });
    }

    const target = parseRepoTarget(parsed.data);
    if (target === null) {
      logWarn("roast.invalid_repo", { repoUrl: parsed.data.repoUrl });
      return jsonResponse(400, {
        error: "invalid-input",
        message: "repoUrl must be a GitHub repository URL",
      });
    }

    // Rate-limit (cheap DB queries) BEFORE GitHub calls (paid quota).
    // An attacker rotating IPs can otherwise burn our unauth 60-req/hr
    // quota with ~30 submissions before any limit fires.
    const ip = firstForwardedIp(req);
    if (ip === null) {
      logError("roast.no_ip");
      return jsonResponse(500, { error: "no-ip" });
    }

    const ipHash = hashIp(ip);
    const recentByIp = await deps.countRecentByIp(ipHash);
    if (recentByIp >= 5) {
      logInfo("roast.rate_limited_ip", { repoFullName: target.repoFullName });
      return jsonResponse(429, {
        error: "rate-limited-ip",
        message: "max 5 submissions per 24h from this ip",
      });
    }

    const recentByRepo = await deps.countRecentByRepo(target.repoFullName);
    if (recentByRepo >= 1) {
      logInfo("roast.rate_limited_repo", { repoFullName: target.repoFullName });
      return jsonResponse(429, {
        error: "rate-limited-repo",
        message: "this repo was already submitted in the last 7 days",
      });
    }

    const octokit = deps.createOctokit();
    const isPublic = await deps.isPublicRepo(octokit, target.owner, target.repo);
    if (!isPublic) {
      logInfo("roast.repo_not_public", { repoFullName: target.repoFullName });
      return jsonResponse(400, {
        error: "repo-not-public",
        message: "repo must be public and visible on GitHub",
      });
    }

    const repoResponse = await octokit.rest.repos.get({ owner: target.owner, repo: target.repo });
    const repoSize = repoResponse.data.size ?? 0;
    if (repoSize > MAX_REPO_SIZE_KB) {
      logInfo("roast.repo_too_large", { repoFullName: target.repoFullName, repoSize });
      return jsonResponse(400, {
        error: "repo-too-large",
        message: "repo must be 500MB or smaller",
      });
    }

    const submissionId = deps.createSubmissionId();
    await deps.insertSubmission({
      id: submissionId,
      repoUrl: normalizedRepoUrl(parsed.data.repoUrl),
      repoFullName: target.repoFullName,
      submitterEmail: parsed.data.submitterEmail ?? null,
      submitterHandle: parsed.data.submitterHandle ?? null,
      ipHash,
      status: "queued",
    });

    logInfo("roast.submitted", { submissionId, repoFullName: target.repoFullName });

    return jsonResponse(200, {
      submissionId,
      statusUrl: `/roasts/${submissionId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("roast.internal", { message });
    return jsonResponse(500, { error: "internal" });
  }
}

async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function parseRepoTarget(body: RoastBody): {
  owner: string;
  repo: string;
  repoFullName: string;
} | null {
  const url = new URL(body.repoUrl);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (owner === undefined || owner.length === 0 || repo === undefined || repo.length === 0) {
    return null;
  }

  const normalizedOwner = owner.toLowerCase();
  const normalizedRepo = repo.toLowerCase();
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    repoFullName: `${normalizedOwner}/${normalizedRepo}`,
  };
}

function normalizedRepoUrl(repoUrl: string): string {
  const url = new URL(repoUrl);
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  return `https://github.com/${owner!.toLowerCase()}/${repo!.toLowerCase()}`;
}

function firstForwardedIp(req: NextRequest): string | null {
  const header = req.headers.get("x-forwarded-for");
  const ip = header?.split(",")[0]?.trim();
  return ip === undefined || ip.length === 0 ? null : ip;
}

function hashIp(ip: string): string {
  // ROAST_IP_SALT is required and must be a >=16 char string; never store raw IPs.
  const salt = process.env["ROAST_IP_SALT"];
  if (!salt || salt.length < 16) {
    throw new Error("ROAST_IP_SALT must be set to a >=16 char string");
  }

  return createHash("sha256")
    .update(ip + salt)
    .digest("hex");
}

function jsonResponse(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
