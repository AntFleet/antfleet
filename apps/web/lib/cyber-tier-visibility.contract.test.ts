import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Cross-surface visibility contract test (architect audit pass-2).
//
// The cyber-tier branch adds an independent filter at MANY public-facing
// query/route call sites. That sprawl is acceptable for auditability
// only if a structural test catches omissions when new public surfaces
// are added. This file is the single source of truth for "every public
// agent_findings / reviews consumer that should hide cyber repos when
// the flag is on".
//
// When a new public surface is added that reads agent_findings (or
// reviews-joined data) without applying the cyber filter, this test
// fails. Either add a cyber filter at the new site OR (rare) add the
// site to ALLOWLISTED_PUBLIC_FILES below with a written justification.

const repoRoot = join(__dirname, "..", "..", "..");
const webRoot = join(repoRoot, "apps", "web");

// Public consumers that MUST contain a reference to one of the cyber-
// tier filter helpers (or directly to repo_tier). Paths are relative to
// the repo root.
const SURFACES_REQUIRING_CYBER_FILTER: ReadonlyArray<{
  path: string;
  filter: RegExp;
  why: string;
}> = [
  // SQL-template raw-CTE surfaces
  {
    path: "apps/web/app/api/v1/agents/route.ts",
    filter: /(rawCyberTierExclusionForFullName|nonCyberTierRepoConditionForFullName|repo_tier)/,
    why: "agent directory aggregates agent_findings by repo_full_name",
  },
  {
    path: "apps/web/app/api/v1/agents/[address]/route.ts",
    filter: /(rawCyberTierExclusionForFullName|nonCyberTierRepoConditionForFullName|repo_tier)/,
    why: "agent detail returns repo_full_name + finding counts from agent_findings",
  },
  {
    path: "apps/web/app/api/v1/agents/[address]/findings/route.ts",
    filter: /(rawCyberTierExclusionForFullName|nonCyberTierRepoConditionForFullName|repo_tier)/,
    why: "per-agent findings list + existence precheck",
  },
  {
    path: "apps/web/app/api/v1/findings/route.ts",
    filter: /(nonCyberTierRepoConditionForFullName|repo_tier)/,
    why: "global v1 findings list",
  },
  {
    path: "apps/web/app/api/v1/findings/[finding_id]/route.ts",
    filter: /(nonCyberTierRepoConditionForFullName|repo_tier)/,
    why: "v1 finding detail",
  },
  {
    path: "apps/web/app/api/v1/stats/route.ts",
    filter: /(rawCyberTierExclusionForFullName|repo_tier)/,
    why: "v1 stats aggregates agent_findings",
  },
  // Drizzle-typed reviews-joined surfaces
  {
    path: "apps/web/db/queries.ts",
    filter:
      /(nonCyberTierRepoCondition|nonCyberTierRepoConditionFor|nonCyberTierRepoConditionForFullName|repo_tier)/,
    why: "public receipt + agent detail loaders",
  },
  {
    path: "apps/web/lib/anatomy.ts",
    filter: /(nonCyberTierRepoCondition|repo_tier)/,
    why: "anatomy bundle loader",
  },
  {
    path: "apps/web/lib/kpis.ts",
    filter: /(nonCyberTierRepoCondition|repo_tier)/,
    why: "patch KPI aggregator",
  },
  {
    path: "apps/web/lib/scorecard.ts",
    filter: /(nonCyberTierRepoCondition|repo_tier)/,
    why: "weekly scorecard sampler",
  },
  {
    path: "apps/web/lib/receipts.ts",
    filter: /(nonCyberTierRepoCondition|cyberTierExclusionForOutgoingPrs|repo_tier)/,
    why: "cross-repo receipts list",
  },
  {
    path: "apps/web/lib/disagreements.ts",
    filter: /(nonCyberTierRepoCondition|repo_tier)/,
    why: "disagreement archive / RSS / OG",
  },
  {
    path: "apps/web/lib/repo-threat-model.ts",
    filter: /cyberTier/,
    why: "threat model public-access derivation",
  },
  {
    path: "apps/web/app/sitemap.ts",
    filter: /(nonCyberTierRepoCondition|repo_tier)/,
    why: "URL crawlable sitemap",
  },
  {
    path: "apps/web/app/disagreements/[id]/page.tsx",
    filter: /(nonCyberTierRepoCondition|repo_tier)/,
    why: "disagreement detail page loader",
  },
  {
    path: "apps/web/app/api/repos/[owner]/[repo]/findings.sarif/route.ts",
    filter: /isCyberTierRepo/,
    why: "SARIF export 404",
  },
  {
    path: "apps/web/lib/identity-drift.ts",
    filter: /isCyberTierRepo/,
    why: "badge SVG count short-circuit",
  },
  {
    path: "apps/web/app/digest/page.tsx",
    filter: /(rawCyberTierExclusionForFullName|repo_tier)/,
    why: "weekly digest renders finding titles from agent_findings",
  },
  {
    path: "apps/web/app/agents/page.tsx",
    filter: /(loadAgentIndex|cyberTier|repo_tier)/,
    why: "agents index page consumes loadAgentIndex (gated inside queries.ts)",
  },
  {
    path: "apps/web/app/agents/[address]/page.tsx",
    filter: /(loadCyberTierFullNameSet|isCyberTierRepo|cyberTier|repo_tier)/,
    why: "agent detail page filters registry + submissions via cyber set",
  },
];

describe("cyber-tier cross-surface visibility contract", () => {
  for (const surface of SURFACES_REQUIRING_CYBER_FILTER) {
    test(`${surface.path} both imports AND uses a cyber-tier filter (${surface.why})`, () => {
      const full = join(repoRoot, surface.path);
      expect(existsSync(full), `surface ${surface.path} not found`).toBe(true);
      const body = readFileSync(full, "utf8");
      // Require ≥2 matches: one for the import statement and one for the
      // actual call/use. Catches the "imported but not applied" failure
      // mode the architect flagged in pass-3 — a file that imports the
      // helper but doesn't wire it into the leaking query branch.
      const matches = body.match(new RegExp(surface.filter.source, "g")) ?? [];
      expect(
        matches.length >= 2,
        `${surface.path} mentions a cyber-tier filter only ${matches.length} time(s) ` +
          `(expected ≥2: one import + at least one call site). ` +
          `Either wire the filter into the leaking query branch, or remove this ` +
          `surface from SURFACES_REQUIRING_CYBER_FILTER with a written justification.`,
      ).toBe(true);
    });
  }

  // Per-loader drift detector for db/queries.ts. The whole-file
  // surface allowlist plus the ≥2-occurrence check covers existing
  // loaders, but a NEW exported loader in db/queries.ts that reads
  // public-data tables without a cyber-tier filter would still slip
  // through because the file-wide count is already satisfied by
  // existing loaders. This test parses queries.ts as a sequence of
  // `export ... load*` blocks, and for each PUBLIC-named loader
  // (load*Public*, load*Page, load*Detail, load*Activity, load*Index,
  // load*Receipts, load*Feature) that references agent_findings or
  // reviews-joined data, asserts the body contains a cyber-tier
  // reference within its own block. (Architect audit pass-6, severity
  // medium, contract-test-gap.)
  test("every public loader in db/queries.ts references a cyber-tier filter", () => {
    const queriesPath = join(repoRoot, "apps/web/db/queries.ts");
    const body = readFileSync(queriesPath, "utf8");
    // Each block is from one `export ... function load*` / `export const
    // load* = cache(` to the start of the next export at top level. We
    // split on `^export ` and treat each segment as a block.
    const segments = body.split(/^export /m);
    // Loaders that are NOT public-facing (internal/operator/cron lanes
    // operate on raw rows; their callers handle access control). Each
    // entry is the export's first identifier exactly.
    const INTERNAL_LOADERS = new Set([
      "loadReviewQueueRow",
      "loadReviewsReadyForRetry",
      "loadPatchAcceptanceWork",
      "loadPatchReviewCommentAcceptanceWork",
      "loadSweepWork",
      "loadCheckInCandidates",
      "loadRoastDetail",
      "loadRoastStats",
      "loadPublishedRoasts",
      "loadScorecardSnapshot",
      "loadScorecardIndex",
      "loadRepoThreatModel",
      "loadPrivateDisclosureFindingIndexes",
      "loadDisclosureFindingDetail",
      "loadDisclosureMaintainerSecret",
      "loadDisclosureTimerCandidates",
      "loadDisclosurePublishCandidates",
      // Pure delegating wrappers — the wrapped function applies the
      // cyber filter, so the wrapper body has no SQL of its own.
      "loadAllTimeActivityWindow",
    ]);
    const PUBLIC_TABLE_PATTERN =
      /\b(agentFindings|reviews|outgoingPrs|repoThreatModel|factoryLaunches|weeklyFeatures)\b/;
    const CYBER_REF_PATTERN =
      /(nonCyberTierRepoCondition|nonCyberTierRepoConditionFor|nonCyberTierRepoConditionForFullName|rawCyberTierExclusionForFullName|cyberTierExclusionFor|getRepoCyberTier|isCyberTierRepo|isCyberTierEnabled|repo_tier)/;
    const NAME_RE = /^(?:async\s+)?(?:function|const)\s+(\w+)/;
    const missing: string[] = [];
    for (const seg of segments) {
      const m = NAME_RE.exec(seg);
      if (!m) continue;
      const name = m[1]!;
      if (!name.startsWith("load")) continue;
      if (INTERNAL_LOADERS.has(name)) continue;
      if (!PUBLIC_TABLE_PATTERN.test(seg)) continue;
      if (CYBER_REF_PATTERN.test(seg)) continue;
      missing.push(name);
    }
    expect(
      missing,
      `Public loader(s) in db/queries.ts reference public-data tables ` +
        `without a cyber-tier reference: ${missing.join(", ")}. Either ` +
        `apply the appropriate cyber-tier helper or add to INTERNAL_LOADERS ` +
        `(with justification that the loader is operator/cron-only).`,
    ).toEqual([]);
  });

  // Drift detector: any NEW file under apps/web that imports
  // `agentFindings` or directly reads `reviews` and is NOT in our
  // contract list must be evaluated explicitly. This is the "I added a
  // public endpoint and forgot to register it" backstop.
  test("no public consumer of agent_findings/reviews escapes the contract list", () => {
    const importPattern = /from ["'][^"']*\/(schema|db)["']/u;
    // Matches BOTH Drizzle-typed table symbols (camelCase) and raw-SQL
    // table identifiers (snake_case, possibly schema-qualified or
    // quoted). The latter catches `db.execute(sql`FROM agent_findings
    // ...`)` patterns that the camelCase-only detector would miss.
    // (Architect audit pass-9, severity medium, contract-test-gap.)
    const tableRefPattern =
      /(\bagentFindings\b|\breviews\b|\brepoThreatModel\b|\boutgoingPrs\b|\bfactoryLaunches\b|\bweeklyFeatures\b|\bagent_findings\b|\breviews\b|\brepo_threat_model\b|\boutgoing_prs\b|\bfactory_launches\b|\bweekly_features\b)/u;
    const allowlisted = new Set(SURFACES_REQUIRING_CYBER_FILTER.map((s) => s.path));

    // Surfaces that are NOT publicly readable (workers, migrations,
    // tests, internal-only routes) and don't need a cyber filter.
    //
    // Architect pass-8 medium: previously this wholesale-skipped
    // `apps/web/lib/`, which would let a NEW public loader in lib
    // escape the contract. Replaced with explicit per-file allowlist
    // for the internal/worker/test files in lib that read public-data
    // tables. Anything new in lib that reads those tables MUST be added
    // to either SURFACES_REQUIRING_CYBER_FILTER (public) or
    // INTERNAL_LIB_LOADERS (operator/cron/worker) with justification.
    const PRIVATE_OR_INTERNAL: ReadonlyArray<string> = [
      // Migrations, dev scripts, fixtures
      "apps/web/db/migrations/",
      "apps/web/scripts/",
      "apps/web/test/",
      // Authenticated admin / operator surfaces (different threat model)
      "apps/web/app/api/admin/",
      // Workers / cron / internal services
      "apps/web/app/api/cron/",
      "apps/web/app/api/github/",
      "apps/web/app/api/internal/",
      "apps/web/app/api/v1/health",
      // The schema/db/index files themselves
      "apps/web/db/schema.ts",
      "apps/web/db/index.ts",
      "apps/web/db/queries.ts", // already in allowlist
      "apps/web/db/public-receipt.ts",
      "apps/web/db/finding-lifecycle.ts",
      "apps/web/db/finding-status-conditions.ts",
      // Sweep / maintainer surfaces are auth-walled or operator-only
      "apps/web/app/api/maintainer/",
      "apps/web/app/api/repos/[owner]/[repo]/sarif/route.ts",
      // x402 paid endpoints — gated by payment; results pass through
      // redactReviewPayloadForPublicDisclosure which is cyber-aware.
      "apps/web/app/api/v1/review/x402/",
      "apps/web/app/api/v1/scan/x402/",
      // Drift snapshots are identity-based (token address), not
      // repo-based — drift is a property of the agent identity, not
      // the repo's findings, so cyber-tier hiding does not apply.
      "apps/web/app/api/v1/agents/[address]/drift/",
      // Roast surfaces use the synthetic 'roast:%' agent_token_address
      // and are deliberately separate from agent_findings cyber scope.
      "apps/web/app/roasts/",
      // Claim flow + wallet aggregate page — out-of-scope for the
      // cyber-tier branch (review with operator before flipping the
      // cyber flag for repos that appear in wallet aggregates).
      "apps/web/app/api/claim/",
      "apps/web/app/wallets/",
    ];
    // Explicit allowlist for lib/ files that read public-data tables
    // but are themselves NOT publicly consumed (workers, internal
    // helpers, persistence layers).
    const INTERNAL_LIB_LOADERS: ReadonlyArray<string> = [
      // Workers + pipeline runners (called by webhook/cron, results are
      // routed through the gated rendering surfaces).
      "apps/web/lib/review-worker.ts",
      "apps/web/lib/review-job-worker.ts",
      "apps/web/lib/review-pipeline.ts",
      "apps/web/lib/review-job-queries.ts",
      "apps/web/lib/onboarder.ts",
      "apps/web/lib/sweep.ts",
      "apps/web/lib/finding-lifecycle.ts",
      "apps/web/lib/finding-publish.ts",
      "apps/web/lib/check-in.ts",
      "apps/web/lib/cyber-tier-admin.ts",
      "apps/web/lib/cyber-tier.ts",
      "apps/web/lib/disclosure.ts",
      "apps/web/lib/disclosure-types.ts",
      "apps/web/lib/disclosure-token.ts",
      "apps/web/lib/disclosure-advisory.ts",
      "apps/web/lib/repo-threat-model.ts",
      "apps/web/lib/reachability-gate.ts",
      "apps/web/lib/patch-verifier.ts",
      "apps/web/lib/patch-agent.ts",
      "apps/web/lib/agent-findings.tsx",
      "apps/web/lib/agent-submissions.ts",
      "apps/web/lib/agent-registry.ts",
      "apps/web/lib/identity-drift.ts", // already in SURFACES_REQUIRING_CYBER_FILTER
      "apps/web/lib/finding-status.ts",
      "apps/web/lib/finding-summary.ts",
      "apps/web/lib/finding-validation-evidence.ts",
      "apps/web/lib/outgoing-prs.ts", // cron-driven poller; writes only
      "apps/web/lib/post-drafts.ts",
      "apps/web/lib/absorbed-inline.ts",
      "apps/web/lib/repo-benchmark.ts",
      "apps/web/lib/repo-visibility.ts",
      "apps/web/lib/triage-provider.ts",
      "apps/web/lib/github-app.ts",
      "apps/web/lib/github-files.ts",
      "apps/web/lib/github-files-public.ts",
      "apps/web/lib/github-signature.ts",
      "apps/web/lib/short-id.ts",
      "apps/web/lib/log.ts",
      "apps/web/lib/alert.ts",
      "apps/web/lib/cron-auth.ts",
      "apps/web/lib/daybreak-gates-env.ts",
      "apps/web/lib/review-worker-config.ts",
      "apps/web/lib/review-types.ts",
      "apps/web/lib/github-files.ts",
      "apps/web/lib/ghsa-client.ts",
      "apps/web/lib/sarif-",
      "apps/web/lib/patch-cost-reconcile.ts", // weekly cost backfill cron
      "apps/web/lib/prelaunch-dispatcher.ts", // factory-launch onboarding worker
      "apps/web/lib/roast-runner.ts", // roast worker (synthetic agents)
      "apps/web/lib/paywall/", // entire paywall subtree — gated by x402/ACP auth
      "apps/web/lib/x402/",
      "apps/web/lib/acp/",
      "apps/web/lib/api-v1/", // serializer + cursor helpers, called from gated routes
      "apps/web/lib/sarif-",
      "apps/web/lib/threat-model-",
      "apps/web/lib/disagreements.ts", // already in SURFACES_REQUIRING_CYBER_FILTER
      "apps/web/lib/anatomy.ts", // already in SURFACES_REQUIRING_CYBER_FILTER
      "apps/web/lib/kpis.ts", // already in SURFACES_REQUIRING_CYBER_FILTER
      "apps/web/lib/scorecard.ts", // already in SURFACES_REQUIRING_CYBER_FILTER
      "apps/web/lib/receipts.ts", // already in SURFACES_REQUIRING_CYBER_FILTER
    ];
    const isPrivateOrInternal = (path: string) =>
      PRIVATE_OR_INTERNAL.some((prefix) => path === prefix || path.startsWith(prefix)) ||
      INTERNAL_LIB_LOADERS.some((prefix) => path === prefix || path.startsWith(prefix));

    const SKIP = new Set([".next", "node_modules", ".turbo", "dist", "build", "memory"]);
    const newPublicLeaks: string[] = [];

    function walk(dir: string): void {
      let entries: string[];
      try {
        entries = require("node:fs").readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP.has(entry)) continue;
        const full = join(dir, entry);
        const st = (() => {
          try {
            return require("node:fs").statSync(full);
          } catch {
            return null;
          }
        })();
        if (!st) continue;
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
          const rel = full.slice(repoRoot.length + 1);
          if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
          if (isPrivateOrInternal(rel)) continue;
          if (allowlisted.has(rel)) continue;
          let body = "";
          try {
            body = readFileSync(full, "utf8");
          } catch {
            continue;
          }
          if (!importPattern.test(body)) continue;
          if (!tableRefPattern.test(body)) continue;
          // Public consumer of a public-data table that's NOT in the
          // contract list. New endpoint without explicit visibility
          // evaluation.
          newPublicLeaks.push(rel);
        }
      }
    }

    walk(webRoot);

    expect(
      newPublicLeaks,
      `New public surface(s) reference agent_findings/reviews/etc. without ` +
        `appearing in SURFACES_REQUIRING_CYBER_FILTER. Either add the cyber-tier ` +
        `filter and register the surface, or add it to PRIVATE_OR_INTERNAL with ` +
        `justification: ${newPublicLeaks.join(", ")}`,
    ).toEqual([]);
  });
});
