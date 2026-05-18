/**
 * Admin tool — backfill `is_benchmark = true` on existing reviews whose
 * repo has BENCHMARK.md at root. Mission 6 companion to the webhook-side
 * detection change: new reviews on benchmark-class repos get isBenchmark=true
 * automatically, but rows that predate the flip are still locked at false.
 * This script catches them up.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/backfill-benchmark-flag.ts            # apply
 *   pnpm exec tsx scripts/backfill-benchmark-flag.ts --dry-run  # decide only
 *
 * Idempotent. Fail closed: a probe error leaves that group untouched.
 * The exported runBenchmarkBackfill() function is the testable core —
 * main() just wires real deps (DB + Octokit + isBenchmarkRepo).
 *
 * Auth: uses GITHUB_TOKEN if present, else unauthenticated (60 req/h).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

// ─── Pure core (testable, no I/O) ──────────────────────────────────────────

export type CandidateGroup = {
  owner: string;
  repo: string;
  reviewIds: string[];
};

export type BenchmarkCheck =
  | { kind: "benchmark" }
  | { kind: "not_benchmark" }
  | { kind: "error"; error: string };

export type GroupDecision = {
  owner: string;
  repo: string;
  rowCount: number;
  decision: "benchmark" | "not_benchmark" | "error";
  error?: string;
  flipped: number;
};

export type BackfillSummary = {
  preState: { totalCandidateRows: number; totalGroups: number };
  decisions: GroupDecision[];
  benchmarkGroups: number;
  nonBenchmarkGroups: number;
  errorGroups: number;
  rowsFlipped: number;
  dryRun: boolean;
};

export type BackfillDeps = {
  loadCandidateGroups: () => Promise<CandidateGroup[]>;
  checkBenchmark: (owner: string, repo: string) => Promise<BenchmarkCheck>;
  flipRows: (reviewIds: string[]) => Promise<number>;
  log: (line: string) => void;
};

export async function runBenchmarkBackfill(
  deps: BackfillDeps,
  opts: { dryRun: boolean },
): Promise<BackfillSummary> {
  const groups = await deps.loadCandidateGroups();
  const totalCandidateRows = groups.reduce((sum, g) => sum + g.reviewIds.length, 0);

  deps.log(
    `[pre-state] ${groups.length} repo group(s) to evaluate; ` +
      `${totalCandidateRows} candidate row(s) total.`,
  );
  if (opts.dryRun) deps.log("[mode] dry-run — no writes will be issued.");

  const decisions: GroupDecision[] = [];
  let benchmarkGroups = 0;
  let nonBenchmarkGroups = 0;
  let errorGroups = 0;
  let rowsFlipped = 0;

  for (const group of groups) {
    const check = await deps.checkBenchmark(group.owner, group.repo);
    if (check.kind === "benchmark") {
      benchmarkGroups += 1;
      let flipped = group.reviewIds.length;
      if (!opts.dryRun) {
        flipped = await deps.flipRows(group.reviewIds);
        rowsFlipped += flipped;
      }
      decisions.push({
        owner: group.owner,
        repo: group.repo,
        rowCount: group.reviewIds.length,
        decision: "benchmark",
        flipped,
      });
      deps.log(
        `  benchmark      ${group.owner}/${group.repo} — ` +
          `${group.reviewIds.length} row(s) ${opts.dryRun ? "would flip" : "flipped"}.`,
      );
    } else if (check.kind === "not_benchmark") {
      nonBenchmarkGroups += 1;
      decisions.push({
        owner: group.owner,
        repo: group.repo,
        rowCount: group.reviewIds.length,
        decision: "not_benchmark",
        flipped: 0,
      });
      deps.log(
        `  not-benchmark  ${group.owner}/${group.repo} — ` +
          `${group.reviewIds.length} row(s) untouched.`,
      );
    } else {
      errorGroups += 1;
      decisions.push({
        owner: group.owner,
        repo: group.repo,
        rowCount: group.reviewIds.length,
        decision: "error",
        error: check.error,
        flipped: 0,
      });
      deps.log(
        `  error          ${group.owner}/${group.repo} — ` +
          `${group.reviewIds.length} row(s) untouched (${check.error}).`,
      );
    }
  }

  deps.log("");
  deps.log(
    `[post-state] benchmark=${benchmarkGroups}  not_benchmark=${nonBenchmarkGroups}  ` +
      `error=${errorGroups}  rowsFlipped=${rowsFlipped}` +
      (opts.dryRun ? " (dry-run, no writes)" : ""),
  );

  return {
    preState: { totalCandidateRows, totalGroups: groups.length },
    decisions,
    benchmarkGroups,
    nonBenchmarkGroups,
    errorGroups,
    rowsFlipped,
    dryRun: opts.dryRun,
  };
}

// ─── Real deps wiring (script entrypoint) ──────────────────────────────────

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const { Octokit } = await import("@octokit/rest");
  const { and, eq, isNotNull } = await import("drizzle-orm");
  const { db } = await import("../db/index");
  const { reviews } = await import("../db/schema");
  const { isBenchmarkRepo } = await import("../lib/repo-benchmark");

  const token = process.env["GITHUB_TOKEN"];
  const octokit = new Octokit(token === undefined || token.length === 0 ? {} : { auth: token });

  const deps: BackfillDeps = {
    loadCandidateGroups: async () => {
      // Group eligible rows by (owner, repo). Skip rows missing owner/repo
      // (predates Mission 3 slice 3-5) — we cannot probe their visibility.
      const rows = await db
        .select({
          reviewId: reviews.reviewId,
          owner: reviews.owner,
          repo: reviews.repo,
        })
        .from(reviews)
        .where(
          and(
            eq(reviews.isBenchmark, false),
            isNotNull(reviews.owner),
            isNotNull(reviews.repo),
          ),
        );
      const byKey = new Map<string, CandidateGroup>();
      for (const r of rows) {
        if (r.owner === null || r.repo === null) continue;
        const key = `${r.owner}/${r.repo}`;
        const existing = byKey.get(key);
        if (existing) {
          existing.reviewIds.push(r.reviewId);
        } else {
          byKey.set(key, { owner: r.owner, repo: r.repo, reviewIds: [r.reviewId] });
        }
      }
      return Array.from(byKey.values()).toSorted((a, b) =>
        `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`),
      );
    },
    checkBenchmark: async (owner, repo) => {
      try {
        const isBench = await isBenchmarkRepo(octokit, owner, repo);
        return { kind: isBench ? "benchmark" : "not_benchmark" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "error", error: message };
      }
    },
    flipRows: async (reviewIds) => {
      if (reviewIds.length === 0) return 0;
      const { inArray } = await import("drizzle-orm");
      const updated = await db
        .update(reviews)
        .set({ isBenchmark: true })
        .where(inArray(reviews.reviewId, reviewIds))
        .returning({ reviewId: reviews.reviewId });
      return updated.length;
    },
    log: (line) => console.log(line),
  };

  await runBenchmarkBackfill(deps, { dryRun });
}

// Only run main() when executed directly, not when imported by tests.
if (process.argv[1]?.endsWith("backfill-benchmark-flag.ts")) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
