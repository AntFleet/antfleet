import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { recoverMessageAddress as viemRecoverMessageAddress } from "viem";
import { z } from "zod";
import { db } from "@/db";
import { agentClaims, factoryLaunches } from "@/db/schema";
import { logError, logInfo, logWarn } from "@/lib/log";
import { parseClaimMessage } from "@/lib/claim-message";
import { isPublicRepo, type RepoVisibilityOctokit } from "@/lib/repo-visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_RATE_LIMIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const claimBodySchema = z.object({
  tokenAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
  message: z.string().min(50).max(500),
});

type ClaimDb = typeof db;
type ClaimQueryable = Pick<ClaimDb, "execute">;

class AlreadyAttributedError extends Error {
  constructor() {
    super("already-attributed");
    this.name = "AlreadyAttributedError";
  }
}

export type ClaimDeps = {
  db: ClaimDb;
  octokit: RepoVisibilityOctokit;
  recoverMessageAddress: (args: { message: string; signature: `0x${string}` }) => Promise<string>;
  isPublicRepo: typeof isPublicRepo;
  createClaimId: () => string;
  now: () => Date;
};

const DEFAULT_DEPS: ClaimDeps = {
  db,
  octokit: new Octokit({
    auth: process.env["ROAST_GH_TOKEN"] ?? process.env["GITHUB_TOKEN"] ?? undefined,
    userAgent: "antfleet-claim-api",
  }),
  recoverMessageAddress: viemRecoverMessageAddress,
  isPublicRepo,
  createClaimId: nanoid,
  now: () => new Date(),
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handleClaim(req, DEFAULT_DEPS);
}

export async function handleClaim(req: NextRequest, deps: ClaimDeps): Promise<NextResponse> {
  try {
    const parsedBody = claimBodySchema.safeParse(await readJson(req));
    if (!parsedBody.success) {
      logWarn("claim.rejected", { reason: "bad-request" });
      return jsonResponse(400, { error: "bad-request" });
    }

    const body = parsedBody.data;
    const normalizedToken = body.tokenAddress.toLowerCase();
    const normalizedRepo = body.repoFullName.toLowerCase();
    logInfo("claim.attempted", {
      tokenAddress: normalizedToken,
      repoFullName: normalizedRepo,
      timestamp: deps.now().toISOString(),
    });

    const parsedMessage = parseClaimMessage(body.message);
    if (parsedMessage === null) {
      return reject(400, "bad-message", normalizedToken);
    }

    if (
      parsedMessage.tokenAddress.toLowerCase() !== normalizedToken ||
      parsedMessage.repoFullName.toLowerCase() !== normalizedRepo
    ) {
      return reject(400, "message-mismatch", normalizedToken);
    }

    const signedAt = new Date(parsedMessage.timestamp).getTime();
    const skew = signedAt - deps.now().getTime();
    // Allow <=30s of clock skew into the future; up to CLAIM_WINDOW_MS into the past.
    if (!Number.isFinite(signedAt) || skew > 30_000 || -skew > CLAIM_WINDOW_MS) {
      return reject(401, "stale-signature", normalizedToken);
    }

    const launch = await loadFactoryLaunch(deps.db, normalizedToken);
    if (launch === null) {
      return reject(404, "token-not-found", normalizedToken);
    }

    const recentClaims = await countRecentClaimAttempts(
      deps.db,
      normalizedToken,
      new Date(deps.now().getTime() - CLAIM_RATE_LIMIT_WINDOW_MS),
    );
    if (recentClaims >= 3) {
      return reject(429, "rate-limited", normalizedToken);
    }

    const recovered = (
      await deps.recoverMessageAddress({
        message: body.message,
        signature: body.signature as `0x${string}`,
      })
    ).toLowerCase();
    if (recovered !== launch.deployerAddress.toLowerCase()) {
      return reject(401, "signature-mismatch", normalizedToken);
    }

    const [owner, repo] = normalizedRepo.split("/") as [string, string];
    if (!(await deps.isPublicRepo(deps.octokit, owner, repo))) {
      return reject(400, "repo-not-public", normalizedToken);
    }

    // Fast bail before opening a transaction: if the launch already points at
    // a different repo, we can't attribute. The transaction below still
    // handles the race-vs-concurrent-claim case via the unique index, but
    // this short-circuit keeps the simple case cheap.
    if (launch.repoFullName !== null && launch.repoFullName.toLowerCase() !== normalizedRepo) {
      return reject(409, "already-attributed", normalizedToken);
    }

    let claimId: string | null = null;
    try {
      await deps.db.transaction(async (tx) => {
        const existing = await loadVerifiedClaim(tx, normalizedToken);
        if (existing !== null) {
          if (existing.repoFullName.toLowerCase() === normalizedRepo) {
            claimId = existing.id;
            return;
          }
          throw new AlreadyAttributedError();
        }

        claimId = deps.createClaimId();
        const now = deps.now();
        await insertVerifiedClaim(tx, {
          id: claimId,
          tokenAddress: normalizedToken,
          repoFullName: normalizedRepo,
          claimedAt: now,
          claimerSignature: body.signature,
          claimerAddress: recovered,
          verifiedAt: now,
        });

        const updated = await attributeFactoryLaunch(tx, normalizedToken, normalizedRepo, now);
        if (!updated) {
          throw new AlreadyAttributedError();
        }
      });
    } catch (err) {
      if (isUniqueViolation(err) || isAlreadyAttributedSignal(err)) {
        return reject(409, "already-attributed", normalizedToken);
      }
      throw err;
    }

    if (claimId === null) {
      throw new Error("claim transaction completed without claim id");
    }

    logInfo("claim.verified", {
      claimId,
      tokenAddress: normalizedToken,
      repoFullName: normalizedRepo,
      claimerAddress: recovered,
    });
    return jsonResponse(200, {
      claimId,
      agentUrl: `/agents/${normalizedToken}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("claim.internal", { message });
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

function reject(status: number, reason: string, tokenAddress: string): NextResponse {
  logWarn("claim.rejected", { tokenAddress, reason });
  return jsonResponse(status, { error: reason });
}

type FactoryLaunchRow = {
  deployerAddress: string;
  repoFullName: string | null;
};

type VerifiedClaimRow = {
  id: string;
  repoFullName: string;
};

async function loadFactoryLaunch(
  claimDb: ClaimDb,
  tokenAddress: string,
): Promise<FactoryLaunchRow | null> {
  const result = await claimDb.execute(sql`
    SELECT
      deployer_address AS "deployerAddress",
      repo_full_name AS "repoFullName"
    FROM ${factoryLaunches}
    WHERE lower(token_address) = ${tokenAddress}
    LIMIT 1
  `);
  return firstRow<FactoryLaunchRow>(result);
}

async function countRecentClaimAttempts(
  claimDb: ClaimQueryable,
  tokenAddress: string,
  since: Date,
): Promise<number> {
  const result = await claimDb.execute(sql`
    SELECT count(*)::int AS "value"
    FROM ${agentClaims}
    WHERE lower(token_address) = ${tokenAddress}
      AND claimed_at >= ${since}
  `);
  const row = firstRow<{ value: number | string }>(result);
  return row === null ? 0 : Number(row.value);
}

async function loadVerifiedClaim(
  claimDb: ClaimQueryable,
  tokenAddress: string,
): Promise<VerifiedClaimRow | null> {
  const result = await claimDb.execute(sql`
    SELECT id AS "id", repo_full_name AS "repoFullName"
    FROM ${agentClaims}
    WHERE lower(token_address) = ${tokenAddress}
      AND status = 'verified'
    ORDER BY verified_at DESC NULLS LAST, claimed_at DESC
    LIMIT 1
  `);
  return firstRow<VerifiedClaimRow>(result);
}

async function insertVerifiedClaim(
  claimDb: ClaimQueryable,
  args: {
    id: string;
    tokenAddress: string;
    repoFullName: string;
    claimedAt: Date;
    claimerSignature: string;
    claimerAddress: string;
    verifiedAt: Date;
  },
): Promise<void> {
  await claimDb.execute(sql`
    INSERT INTO ${agentClaims} (
      id,
      token_address,
      repo_full_name,
      claimed_at,
      claimer_signature,
      claimer_address,
      status,
      verified_at
    ) VALUES (
      ${args.id},
      ${args.tokenAddress},
      ${args.repoFullName},
      ${args.claimedAt},
      ${args.claimerSignature},
      ${args.claimerAddress},
      'verified',
      ${args.verifiedAt}
    )
  `);
}

async function attributeFactoryLaunch(
  claimDb: ClaimQueryable,
  tokenAddress: string,
  repoFullName: string,
  now: Date,
): Promise<boolean> {
  const result = await claimDb.execute(sql`
    UPDATE ${factoryLaunches}
    SET
      repo_full_name = ${repoFullName},
      repo_discovery_method = 'operator_submission',
      repo_discovered_at = ${now}
    WHERE lower(token_address) = ${tokenAddress}
      AND repo_full_name IS NULL
  `);
  return rowCount(result) > 0;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

function isAlreadyAttributedSignal(err: unknown): boolean {
  return err instanceof AlreadyAttributedError;
}

function firstRow<T>(result: unknown): T | null {
  const rows = Array.isArray(result)
    ? result
    : Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: unknown[] }).rows
      : [];
  return (rows[0] as T | undefined) ?? null;
}

function rowCount(result: unknown): number {
  return (
    (result as { rowCount?: number | null }).rowCount ?? (Array.isArray(result) ? result.length : 0)
  );
}

function jsonResponse(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
