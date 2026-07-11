/**
 * Step 0 (issue #134): forensic decomposition of the AntSeed dogfood re-runs.
 *
 * Reads PROD reviews (ep-crimson-hall) for the bench-antseed repo and, for each
 * stored run, attributes the funnel WITHOUT re-calling any model:
 *
 *   triage skip? -> provider error (degradation)? -> did each model's RAW
 *   output flag the target? -> did the matcher keep it in agreed[]?
 *
 * Every antseed re-run persisted a `reviews` row (empty-commit retrigger ->
 * new commit_sha -> distinct idempotency key). provider_responses holds each
 * model's pre-consensus findings; agreement_decision holds the post-consensus
 * agreed[]. So the runs that "dropped to 0" are recoverable here for $0.
 *
 * Usage (from apps/web):
 *   DATABASE_URL="$PROD_DB" pnpm exec tsx scripts/step0-forensic-antseed.ts
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

// Read-only forensic, but assert we're pointed at PROD — the bench rows only
// exist in ep-crimson-hall; DEV (ep-jolly-sunset) would silently return 0 rows.
if (!process.env.DATABASE_URL?.includes("ep-crimson-hall")) {
  throw new Error(
    'refusing: DATABASE_URL must point to prod (ep-crimson-hall). Prefix DATABASE_URL="$PROD_DB".',
  );
}

type Ev = { path?: string | null; symbol?: string | null; quote?: string | null };
type RawFinding = {
  title?: string;
  severity?: string;
  category?: string;
  reasoning?: string;
  evidence?: Ev[];
};
type PerProvider = {
  name?: string;
  modelId?: string;
  output?: { findings?: RawFinding[] } | null;
  error?: string | null;
  ms?: number;
};

function haystack(f: RawFinding): string {
  const ev = (f.evidence ?? [])
    .map((e) => `${e.path ?? ""} ${e.symbol ?? ""} ${e.quote ?? ""}`)
    .join(" ");
  return `${f.title ?? ""} ${f.reasoning ?? ""} ${ev}`.toLowerCase();
}

// The two dogfood targets (docs/demos/antseed-dogfood-2026-07.md).
// T1: AntseedDeposits.sol zeroes platformFee when protocolReserve == address(0)
// T3: receipt signature omits unitPrice
const TARGETS: { key: string; label: string; match: (f: RawFinding) => boolean }[] = [
  {
    key: "T1",
    label: "fee-zero (AntseedDeposits.sol)",
    match: (f) => {
      const h = haystack(f);
      return (
        /protocolreserve|platformfee|antseeddeposit/.test(h) &&
        /(fee|reserve|zero|address\(0\))/.test(h)
      );
    },
  },
  {
    key: "T3",
    label: "receipt unitPrice",
    match: (f) => {
      const h = haystack(f);
      return (
        /unitprice|unit price/.test(h) || (/receipt/.test(h) && /(sig|signature|price)/.test(h))
      );
    },
  },
];

function findingsOf(pp: PerProvider | undefined): RawFinding[] {
  return pp?.output?.findings ?? [];
}
function has(fs: RawFinding[], t: (typeof TARGETS)[number]): boolean {
  return fs.some((f) => t.match(f));
}
function short(s: string): string {
  return s.replace(/\s+/g, " ").slice(0, 40);
}
function flag(b: boolean): string {
  return b ? "✓" : "✗";
}
function titles(fs: RawFinding[]): string {
  return fs.length === 0
    ? "(none)"
    : fs.map((f) => `${(f.severity ?? "?")[0]}:${f.title ?? "?"}`).join(" | ");
}

async function main(): Promise<void> {
  const { db, schema } = await import("@/db");
  const { ilike, asc } = await import("drizzle-orm");

  const rows = await db
    .select({
      reviewId: schema.reviews.reviewId,
      prNumber: schema.reviews.prNumber,
      commitSha: schema.reviews.commitSha,
      repo: schema.reviews.repo,
      status: schema.reviews.processingStatus,
      createdAt: schema.reviews.createdAt,
      timingMs: schema.reviews.timingMs,
      processingError: schema.reviews.processingError,
      providerResponses: schema.reviews.providerResponses,
      agreementDecision: schema.reviews.agreementDecision,
      filesReviewed: schema.reviews.filesReviewed,
    })
    .from(schema.reviews)
    .where(ilike(schema.reviews.repo, "%antseed%"))
    .orderBy(asc(schema.reviews.createdAt));

  console.log(`\n=== Step 0 forensic: ${rows.length} antseed review rows (PROD) ===\n`);

  type Agg = {
    runs: number;
    agreedHit: number; // target in agreed[]
    rawA: number; // target in anthropic raw
    rawO: number; // target in openai raw
    bothRaw: number; // target in BOTH raw outputs
    eligible: number; // runs where both providers succeeded (matcher could act)
  };
  const perTargetByPr = new Map<string, Agg>();
  const bump = (k: string, f: (a: Agg) => void) => {
    const a = perTargetByPr.get(k) ?? {
      runs: 0,
      agreedHit: 0,
      rawA: 0,
      rawO: 0,
      bothRaw: 0,
      eligible: 0,
    };
    f(a);
    perTargetByPr.set(k, a);
  };

  let skipped = 0;
  let degradedCount = 0;
  const providerErr: Record<string, number> = {};

  for (const r of rows) {
    const ad = (r.agreementDecision ?? {}) as Record<string, unknown>;
    const shaShort = String(r.commitSha).slice(0, 7);
    const when =
      r.createdAt instanceof Date ? r.createdAt.toISOString().slice(0, 19) : String(r.createdAt);

    if ((ad as { status?: string }).status === "skipped") {
      skipped++;
      console.log(
        `[${when}] PR#${r.prNumber} ${shaShort} status=${r.status}  ->  SKIPPED (no-file / triage skip)`,
      );
      continue;
    }

    const pr = (r.providerResponses ?? {}) as { perProvider?: PerProvider[] };
    const perProvider = pr.perProvider ?? [];
    const anth = perProvider.find((p) => p.name === "anthropic");
    const oai = perProvider.find((p) => p.name === "openai");
    const anthF = findingsOf(anth);
    const oaiF = findingsOf(oai);
    const agreed = (Array.isArray(ad.agreed) ? ad.agreed : []) as RawFinding[];

    const degraded = ad.degraded === true;
    if (degraded) degradedCount++;
    const triage = ad.triage as { worthEscalating?: boolean } | null | undefined;
    const triageState =
      triage == null ? "none" : triage.worthEscalating === false ? "SKIP" : "escalate";

    const anthCell = anth?.error ? `ERROR(${short(anth.error)})` : `${anthF.length}f`;
    const oaiCell = oai?.error ? `ERROR(${short(oai.error)})` : `${oaiF.length}f`;
    if (anth?.error) providerErr["anthropic"] = (providerErr["anthropic"] ?? 0) + 1;
    if (oai?.error) providerErr["openai"] = (providerErr["openai"] ?? 0) + 1;

    const bothOk = !anth?.error && !oai?.error && anth !== undefined && oai !== undefined;

    console.log(
      `[${when}] PR#${r.prNumber} ${shaShort} status=${r.status} | anthropic:${anthCell} openai:${oaiCell} | agreed=${agreed.length} degraded=${degraded} triage=${triageState}`,
    );

    for (const t of TARGETS) {
      const inA = has(anthF, t);
      const inO = has(oaiF, t);
      const inAgreed = has(agreed, t);
      // Only report a target line when at least one raw side or agreed mentions it
      // OR the PR is the one this target lives on (kept simple: report if any hit).
      if (inA || inO || inAgreed) {
        console.log(
          `        ${t.key} ${t.label.padEnd(30)} rawA=${flag(inA)} rawO=${flag(inO)} -> agreed=${flag(inAgreed)}${
            inA && inO && !inAgreed ? "   <<< MATCHER DROP (both raw, not agreed)" : ""
          }`,
        );
      }
      const gk = `PR#${r.prNumber}:${t.key}`;
      bump(gk, (a) => {
        // Count a PR:target aggregate only for runs where the target appears
        // anywhere for that PR (so we don't dilute recall with the other PR's
        // target). We approximate "this target belongs to this PR" as: it was
        // seen in raw or agreed on at least one run of this PR.
        if (inA || inO || inAgreed || a.runs > 0) {
          a.runs++;
          if (inAgreed) a.agreedHit++;
          if (inA) a.rawA++;
          if (inO) a.rawO++;
          if (inA && inO) a.bothRaw++;
          if (bothOk) a.eligible++;
        }
      });
    }

    // Dump raw titles for any run that produced 0 agreed — the interesting ones.
    if (agreed.length === 0) {
      if (anth?.error) console.log(`        anthropic ERROR (full): ${anth.error.slice(0, 700)}`);
      else console.log(`        raw anthropic: ${titles(anthF)}`);
      console.log(`        raw openai:    ${oai?.error ? "ERROR" : titles(oaiF)}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(
    `rows=${rows.length} skipped=${skipped} degraded=${degradedCount} providerErrors=${JSON.stringify(providerErr)}`,
  );
  console.log(`\nPer PR x target (recall across re-runs):`);
  console.log(`  key                 runs  end2end(agreed)  rawA   rawO   bothRaw  eligible(2ok)`);
  for (const [k, a] of [...perTargetByPr.entries()].toSorted()) {
    const pct = (n: number) => (a.runs ? `${n}/${a.runs}` : "0/0");
    console.log(
      `  ${k.padEnd(18)} ${String(a.runs).padStart(4)}  ${pct(a.agreedHit).padStart(13)}  ${pct(a.rawA).padStart(5)} ${pct(a.rawO).padStart(5)} ${pct(a.bothRaw).padStart(7)}  ${String(a.eligible).padStart(5)}`,
    );
  }
  console.log(``);
}

void main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
