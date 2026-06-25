// Operator-only setter for repo cyber tier (migration 0048).
//
// THIS MODULE IS THE SINGLE SOURCE OF MUTATION for repo_tier. Importing
// `setRepoCyberTier` from anywhere except the admin route or its tests
// is a policy violation:
//
//   - Webhooks / install onboarding / paid-rail flows MUST NOT call this.
//   - Self-service settings UI MUST NOT call this.
//   - cyber-tier.ts (read side) intentionally does not re-export it.
//
// Enforced by the grep-test in lib/cyber-tier-admin.test.ts which scans
// for any non-admin import of this module and fails CI.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { repoTier, repoTierChangeLog, type CyberTier, type RepoTierChangeLog } from "@/db/schema";
import { getRepoCyberTier } from "./cyber-tier";

// Reason length matches the SQL CHECK on repo_tier_change_log.reason.
// Floor of 10 forces a real explanation; ceiling of 2000 keeps unbounded
// blobs out of the audit log.
export const REASON_MIN_CHARS = 10;
export const REASON_MAX_CHARS = 2000;

export type SetRepoCyberTierResult =
  | { ok: true; oldTier: CyberTier; newTier: CyberTier }
  | { ok: false; reason: "invalid_reason" | "invalid_tier" | "noop" };

export async function setRepoCyberTier(args: {
  owner: string;
  repo: string;
  newTier: CyberTier;
  reason: string;
  actor: string;
  now?: Date;
}): Promise<SetRepoCyberTierResult> {
  if (args.newTier !== "default" && args.newTier !== "cyber") {
    return { ok: false, reason: "invalid_tier" };
  }
  const trimmedReason = args.reason.trim();
  if (trimmedReason.length < REASON_MIN_CHARS || trimmedReason.length > REASON_MAX_CHARS) {
    return { ok: false, reason: "invalid_reason" };
  }
  const ownerLc = args.owner.toLowerCase();
  const repoLc = args.repo.toLowerCase();
  const now = args.now ?? new Date();

  // Serialize concurrent operator calls for the same repo on a Postgres
  // advisory transaction lock keyed by the normalized repo identifier.
  // The lock pairs the prior-tier read with the upsert + log insert so
  // two concurrent admin POSTs cannot both observe the same `oldTier`
  // and write duplicate / out-of-order change-log rows. (Code audit
  // pass-1, severity medium, race.)
  //
  // hashtextextended returns a stable 64-bit signed int per input — fits
  // the bigint pg_advisory_xact_lock(bigint) signature without manual
  // CRC. Lock is auto-released at transaction end (commit or rollback).
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerLc} || '/' || ${repoLc}, 0))`,
    );
    const existing = await tx
      .select({ tier: repoTier.tier })
      .from(repoTier)
      .where(and(eq(repoTier.ownerLc, ownerLc), eq(repoTier.repoLc, repoLc)))
      .limit(1);
    const oldTier: CyberTier = existing[0]?.tier ?? "default";
    if (oldTier === args.newTier) {
      return { ok: false, reason: "noop" };
    }
    await tx
      .insert(repoTier)
      .values({
        ownerLc,
        repoLc,
        tier: args.newTier,
        setBy: args.actor,
        setAt: now,
      })
      .onConflictDoUpdate({
        target: [repoTier.ownerLc, repoTier.repoLc],
        set: { tier: args.newTier, setBy: args.actor, setAt: now },
      });
    await tx.insert(repoTierChangeLog).values({
      ownerLc,
      repoLc,
      oldTier,
      newTier: args.newTier,
      reason: trimmedReason,
      actor: args.actor,
      changedAt: now,
    });
    // Snapshot invalidation: the change-log insert above is itself the
    // invalidation signal. Reads in db/queries.ts:loadScorecardSnapshot
    // / loadScorecardIndex compare each snapshot's `generated_at` to
    // the latest `repo_tier_change_log.changed_at` and skip stale
    // rows. Snapshots are NOT physically deleted — they stay in the DB
    // and are simply hidden until the weekly cron (or an on-demand
    // backfill) regenerates them with the current cyber filter active.
    // (Architect audit pass-9: avoids the global outage caused by an
    // unconditional DELETE that the prior pass-8 fix introduced;
    // privacy contract still holds because reads filter out any
    // snapshot generated before this change.)
    return { ok: true, oldTier, newTier: args.newTier };
  });
}

// Direct read used by the admin GET path. Bypasses the flag gate so
// operators can see the stored value even when the policy is dormant.
export async function readRepoCyberTierIgnoringFlag(args: {
  owner: string;
  repo: string;
}): Promise<CyberTier> {
  const ownerLc = args.owner.toLowerCase();
  const repoLc = args.repo.toLowerCase();
  const rows = await db
    .select({ tier: repoTier.tier })
    .from(repoTier)
    .where(and(eq(repoTier.ownerLc, ownerLc), eq(repoTier.repoLc, repoLc)))
    .limit(1);
  return rows[0]?.tier ?? "default";
}

export async function loadRepoTierChangeLog(args: {
  owner: string;
  repo: string;
  limit?: number;
}): Promise<RepoTierChangeLog[]> {
  const ownerLc = args.owner.toLowerCase();
  const repoLc = args.repo.toLowerCase();
  const rows = await db
    .select()
    .from(repoTierChangeLog)
    .where(and(eq(repoTierChangeLog.ownerLc, ownerLc), eq(repoTierChangeLog.repoLc, repoLc)))
    .orderBy(desc(repoTierChangeLog.changedAt))
    .limit(args.limit ?? 25);
  return rows;
}

// Re-export the flag-gated read so operators can see the effective
// (flag-applied) value through the admin route too.
export { getRepoCyberTier };
