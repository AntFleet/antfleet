import { sql } from "drizzle-orm";
import { db } from "@/db";

type Queryable = Pick<typeof db, "execute">;

export const ACP_WALLET_LIMIT = 10;
export const ACP_WALLET_WINDOW_SECONDS = 60 * 60;
export const ACP_REPO_COOLDOWN_SECONDS = 10 * 60;

export type AcpRateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; limit: number };

export async function checkAcpWalletRateLimit(
  q: Queryable,
  args: {
    clientWallet: string;
    now: Date;
    limit?: number;
    windowSeconds?: number;
  },
): Promise<AcpRateLimitResult> {
  const limit = args.limit ?? ACP_WALLET_LIMIT;
  const windowSeconds = args.windowSeconds ?? ACP_WALLET_WINDOW_SECONDS;
  const windowStart = new Date(args.now.getTime() - windowSeconds * 1000);
  const result = await q.execute(sql`
    SELECT created_at AS "createdAt"
    FROM review_jobs
    WHERE payment_rail = 'acp'
      AND lower(acp_client_wallet) = ${args.clientWallet.toLowerCase()}
      AND created_at >= ${windowStart}
      AND (
        status IN ('billing_pending', 'queued', 'running', 'complete')
        OR (status = 'failed' AND failure_mode IS DISTINCT FROM 'invalid_input')
      )
    ORDER BY created_at ASC
  `);
  const rows = rowsOf<{ createdAt: Date | string }>(result);
  if (rows.length < limit) return { ok: true };
  const oldest = parseDate(rows[0]!.createdAt);
  return {
    ok: false,
    retryAfterSeconds: retryAfterSeconds(oldest, args.now, windowSeconds),
    limit,
  };
}

export type AcpRepoCooldownResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; cooldownSeconds: number };

export async function checkAcpRepoCooldown(
  q: Queryable,
  args: {
    owner: string;
    repo: string;
    now: Date;
    cooldownSeconds?: number;
  },
): Promise<AcpRepoCooldownResult> {
  const cooldownSeconds = args.cooldownSeconds ?? ACP_REPO_COOLDOWN_SECONDS;
  const windowStart = new Date(args.now.getTime() - cooldownSeconds * 1000);
  const result = await q.execute(sql`
    SELECT created_at AS "createdAt"
    FROM review_jobs
    WHERE payment_rail = 'acp'
      AND lower(repo_owner) = ${args.owner.toLowerCase()}
      AND lower(repo_name) = ${args.repo.toLowerCase()}
      AND created_at >= ${windowStart}
      AND (
        status IN ('billing_pending', 'queued', 'running', 'complete')
        OR (status = 'failed' AND failure_mode IS DISTINCT FROM 'invalid_input')
      )
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const row = firstRow<{ createdAt: Date | string }>(result);
  if (row === null) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: retryAfterSeconds(parseDate(row.createdAt), args.now, cooldownSeconds),
    cooldownSeconds,
  };
}

function retryAfterSeconds(start: Date, now: Date, windowSeconds: number): number {
  return Math.max(1, Math.ceil((start.getTime() + windowSeconds * 1000 - now.getTime()) / 1000));
}

function parseDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function firstRow<T>(result: unknown): T | null {
  const rows = rowsOf<T>(result);
  return rows[0] ?? null;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === "object" && result !== null && "rows" in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}
