/**
 * Admin tool — backfill `public_receipt = true` for every review row whose
 * (owner, repo) is a public GitHub repo. Mission 5 companion to the
 * webhook-side default change: new reviews on public repos get
 * publicReceipt=true automatically, but rows that predate the flip are
 * still locked at false. This script catches them up.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/backfill-public-repo-receipts.ts            # write
 *   pnpm exec tsx scripts/backfill-public-repo-receipts.ts --dry-run  # report
 *
 * Idempotent: re-running has no effect on already-public rows (they're
 * excluded by the candidate query). Fail closed: any error fetching repo
 * visibility leaves that group's rows untouched, never accidentally flipped
 * to public. Skips rows with NULL installation_id/owner/repo (predates
 * the Mission 3 slice 3-5 columns; we can't auth back to GitHub for them).
 *
 * Operator workflow: run with --dry-run first, eyeball the per-group
 * decisions and counts, then run without --dry-run to apply.
 *
 * The exported runBackfill() function is the testable core — main() just
 * wires real deps (DB + installation tokens + Octokit) and prints.
 */
import type { Octokit as OctokitType } from "@octokit/rest";

// ─── Pure core (testable, no I/O) ──────────────────────────────────────────

export type CandidateGroup = {
  installationId: number;
  owner: string;
  repo: string;
  reviewIds: string[];
};

export type VisibilityCheck =
  | { kind: "public" }
  | { kind: "private" }
  | { kind: "error"; error: string };

export type GroupDecision = {
  installationId: number;
  owner: string;
  repo: string;
  rowCount: number;
  decision: "public" | "private" | "error";
  error?: string;
  flipped: number;
};

export type BackfillSummary = {
  preState: { totalCandidateRows: number; totalGroups: number };
  decisions: GroupDecision[];
  publicGroups: number;
  privateGroups: number;
  errorGroups: number;
  rowsFlipped: number;
  dryRun: boolean;
};

export type BackfillDeps = {
  loadCandidateGroups: () => Promise<CandidateGroup[]>;
  checkVisibility: (
    installationId: number,
    owner: string,
    repo: string,
  ) => Promise<VisibilityCheck>;
  flipRows: (reviewIds: string[]) => Promise<number>;
  log: (line: string) => void;
};

export async function runBackfill(
  deps: BackfillDeps,
  opts: { dryRun: boolean },
): Promise<BackfillSummary> {
  const groups = await deps.loadCandidateGroups();
  const totalCandidateRows = groups.reduce((sum, g) => sum + g.reviewIds.length, 0);

  deps.log(
    `[pre-state] ${groups.length} actionable group(s); ` +
      `${totalCandidateRows} candidate row(s) total ` +
      `(rows missing installation_id/owner/repo are reported separately and skipped).`,
  );
  if (opts.dryRun) {
    deps.log("[mode] dry-run — no writes will be issued.");
  }

  const decisions: GroupDecision[] = [];
  let publicGroups = 0;
  let privateGroups = 0;
  let errorGroups = 0;
  let rowsFlipped = 0;

  for (const group of groups) {
    const check = await deps.checkVisibility(
      group.installationId,
      group.owner,
      group.repo,
    );
    if (check.kind === "public") {
      publicGroups += 1;
      let flipped = 0;
      if (!opts.dryRun) {
        flipped = await deps.flipRows(group.reviewIds);
      } else {
        flipped = group.reviewIds.length; // counterfactual count for reporting
      }
      rowsFlipped += opts.dryRun ? 0 : flipped;
      decisions.push({
        installationId: group.installationId,
        owner: group.owner,
        repo: group.repo,
        rowCount: group.reviewIds.length,
        decision: "public",
        flipped,
      });
      deps.log(
        `  public  ${group.owner}/${group.repo} — ` +
          `${group.reviewIds.length} row(s) ${opts.dryRun ? "would flip" : "flipped"}.`,
      );
    } else if (check.kind === "private") {
      privateGroups += 1;
      decisions.push({
        installationId: group.installationId,
        owner: group.owner,
        repo: group.repo,
        rowCount: group.reviewIds.length,
        decision: "private",
        flipped: 0,
      });
      deps.log(
        `  private ${group.owner}/${group.repo} — ` +
          `${group.reviewIds.length} row(s) untouched.`,
      );
    } else {
      errorGroups += 1;
      decisions.push({
        installationId: group.installationId,
        owner: group.owner,
        repo: group.repo,
        rowCount: group.reviewIds.length,
        decision: "error",
        error: check.error,
        flipped: 0,
      });
      deps.log(
        `  error   ${group.owner}/${group.repo} — ` +
          `${group.reviewIds.length} row(s) untouched (${check.error}).`,
      );
    }
  }

  deps.log("");
  deps.log(
    `[post-state] public=${publicGroups}  private=${privateGroups}  ` +
      `error=${errorGroups}  rowsFlipped=${rowsFlipped}` +
      (opts.dryRun ? " (dry-run, no writes)" : ""),
  );

  return {
    preState: { totalCandidateRows, totalGroups: groups.length },
    decisions,
    publicGroups,
    privateGroups,
    errorGroups,
    rowsFlipped,
    dryRun: opts.dryRun,
  };
}

// ─── Real deps wiring (script entrypoint) ──────────────────────────────────

async function main(): Promise<void> {
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv({ path: ".env.local", quiet: true });

  const dryRun = process.argv.slice(2).includes("--dry-run");

  // Dynamic imports so dotenv runs before db/index.ts evaluates its
  // DATABASE_URL guard. Mirrors the pattern in enable-public-receipts.ts.
  const { eq, inArray } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { reviews } = await import("../db/schema");
  const { getInstallationToken } = await import("../lib/github-app");
  const { Octokit } = await import("@octokit/rest");
  const { logWarn } = await import("../lib/log");

  const deps: BackfillDeps = {
    loadCandidateGroups: async () => {
      const rows = await db
        .select({
          reviewId: reviews.reviewId,
          installationId: reviews.installationId,
          owner: reviews.owner,
          repo: reviews.repo,
        })
        .from(reviews)
        .where(eq(reviews.publicReceipt, false));

      const byKey = new Map<string, CandidateGroup>();
      let skipped = 0;
      for (const r of rows) {
        if (r.installationId === null || r.owner === null || r.repo === null) {
          skipped += 1;
          continue;
        }
        const key = `${r.installationId}#${r.owner}#${r.repo}`;
        let group = byKey.get(key);
        if (group === undefined) {
          group = {
            installationId: r.installationId,
            owner: r.owner,
            repo: r.repo,
            reviewIds: [],
          };
          byKey.set(key, group);
        }
        group.reviewIds.push(r.reviewId);
      }
      if (skipped > 0) {
        console.log(
          `[skip] ${skipped} row(s) lacked installation_id/owner/repo — cannot backfill.`,
        );
      }
      return Array.from(byKey.values());
    },

    // Memoize per installation token + Octokit so the same install across
    // many repos doesn't re-mint a token each call. Token acquisition
    // failure (revoked install, etc.) surfaces as an error VisibilityCheck
    // rather than a process exit — fail closed, keep going.
    checkVisibility: (() => {
      const octokitByInstall = new Map<number, OctokitType>();
      return async (installationId, owner, repo): Promise<VisibilityCheck> => {
        let octokit = octokitByInstall.get(installationId);
        if (octokit === undefined) {
          try {
            const token = await getInstallationToken(installationId);
            octokit = new Octokit({ auth: token });
            octokitByInstall.set(installationId, octokit);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            return { kind: "error", error: `installation token: ${error}` };
          }
        }
        // Re-call repos.get directly (rather than going through isPublicRepo)
        // so the operator-facing report can distinguish "private" from
        // "error". Both branches are safe — neither flips rows — but the
        // distinction matters when sizing the universe of repos that need
        // operator follow-up. Emit the same structured warning the webhook
        // path produces via isPublicRepo, so ops sees one log shape across
        // both flows.
        try {
          const { data } = await octokit.rest.repos.get({ owner, repo });
          return data.private === false ? { kind: "public" } : { kind: "private" };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          logWarn("repo_visibility.lookup_failed", { owner, repo, error });
          return { kind: "error", error };
        }
      };
    })(),

    flipRows: async (reviewIds: string[]) => {
      if (reviewIds.length === 0) return 0;
      const updated = await db
        .update(reviews)
        .set({ publicReceipt: true })
        .where(inArray(reviews.reviewId, reviewIds))
        .returning({ reviewId: reviews.reviewId });
      return updated.length;
    },

    log: (line) => {
      console.log(line);
    },
  };

  await runBackfill(deps, { dryRun });
}

// Don't run main() when this module is imported by a test. Compare the
// realpath-resolved entrypoint to fileURLToPath(import.meta.url) so the
// check survives symlinks (pnpm workspace links, .bin shims, etc.).
async function isEntry(): Promise<boolean> {
  if (typeof process === "undefined" || process.argv[1] === undefined) return false;
  const { fileURLToPath } = await import("node:url");
  const { realpathSync } = await import("node:fs");
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (await isEntry()) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
