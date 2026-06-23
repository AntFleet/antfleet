#!/usr/bin/env tsx
// Bench dry-run for the Daybreak reachability + patch-verify gates.
//
// Reads recent agreed findings from bench-class reviews in the local dev DB,
// runs each through the two gates with flags forcibly ON, and writes a
// markdown report under .omc/research/. The DB write to review_gate_outcomes
// is best-effort — if migration 0041 has not been applied locally, the
// script still completes and the report still lands; the gate outcomes are
// surfaced inline instead.
//
// Cost controls:
//   - Reachability gate: cap N=12 calls (Haiku, ~$0.001 each).
//   - Patch verifier: cap N=6 calls (no LLM, but each clones a repo).
//   - Per-bench-repo cap of 3 findings.
//
// Safety:
//   - DB queries are READ-ONLY against finding_status / reviews.
//   - Patch verifier worktrees land under /tmp/antfleet-pv-* per spec.
//   - Subprocess env in the verifier is whitelisted (no inherited tokens).
//   - Reachability prompts fence finding text inside a per-call nonce.
//   - On any HIGH-severity reachable verdict against a known live-protocol
//     repo, the script logs a flag and SKIPS publishing the file:line
//     details so the operator routes it through the live-protocol path
//     manually (feedback_live_protocol_disclosure).
//
// Usage:
//   pnpm exec tsx scripts/bench-dryrun-daybreak-gates.ts

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import * as dotenv from "dotenv";

const selfPath = fileURLToPath(import.meta.url);
const selfDir = dirname(selfPath);
dotenv.config({ path: resolve(selfDir, "../.env.local") });

// Flip the flags ON in-process so the gates execute even if the env file
// has them set to false (bench, not prod).
process.env["ANTFLEET_REACHABILITY_GATE"] = "true";
process.env["ANTFLEET_PATCH_VERIFY"] = "true";

const REACHABILITY_BUDGET = 12;
const PATCH_VERIFY_BUDGET = 6;
const FINDINGS_PER_REPO = 3;
const RECENT_DAYS = 90;

// Known live-mainnet protocols we may have benched. If one of these
// surfaces a `reachable` HIGH, we mute the publish path and tell the
// operator instead — per feedback_live_protocol_disclosure.
const LIVE_MAINNET_REPO_HINTS = ["doppler", "morpho", "uniswap", "aave", "compound", "lido"];

type AgreedFinding = {
  title: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low";
  evidence: Array<{ path: string; startLine: number | null; endLine: number | null }>;
  reasoning: string;
  reproduction: string | null;
  recommendation: string;
};

type BenchRow = {
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  agreementDecision: unknown;
  findingStatuses: Array<{ findingId: string; suggestedPatch: string | null }>;
};

type ReachabilityRecord = {
  reviewId: string;
  owner: string;
  repo: string;
  finding: AgreedFinding;
  verdict: "reachable" | "unreachable" | "uncertain";
  reason: string;
  modelId: string;
  ms: number;
  error: string | null;
};

type PatchVerifyRecord = {
  reviewId: string;
  owner: string;
  repo: string;
  findingId: string;
  verdict: "verified" | "regressed" | "inconclusive";
  detector: string;
  notes: string;
  ms: number;
};

async function main(): Promise<void> {
  const { db } = await import("@/db");
  const { reviews, findingStatus } = await import("@/db/schema");
  const { sql, eq, and, gte } = await import("drizzle-orm");
  const { runReachabilityGate } = await import("@/lib/reachability-gate");
  const { runPatchVerifier, realPatchVerifierIo } = await import("@/lib/patch-verifier");
  const { recordGateOutcome } = await import("@/db/queries");
  const { getPublicChangedFiles, PublicRepoAccessError } =
    await import("@/lib/github-files-public");
  const filesCache = new Map<string, Awaited<ReturnType<typeof getPublicChangedFiles>> | null>();
  const fetchFiles = async (
    owner: string,
    repo: string,
    prNumber: number,
    sha: string,
  ): Promise<Awaited<ReturnType<typeof getPublicChangedFiles>>> => {
    const key = `${owner}/${repo}#${prNumber}@${sha}`;
    if (filesCache.has(key)) return filesCache.get(key) ?? [];
    try {
      const files = await getPublicChangedFiles({ owner, repo, prNumber, headSha: sha });
      filesCache.set(key, files);
      return files;
    } catch (err) {
      if (err instanceof PublicRepoAccessError) {
        console.warn(`[bench-dryrun] ${key} is private or 404 — falling back to evidence-only`);
      } else {
        console.warn(`[bench-dryrun] file fetch failed for ${key}: ${(err as Error).message}`);
      }
      filesCache.set(key, null);
      return [];
    }
  };

  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      reviewId: reviews.reviewId,
      owner: reviews.owner,
      repo: reviews.repo,
      prNumber: reviews.prNumber,
      commitSha: reviews.commitSha,
      agreementDecision: reviews.agreementDecision,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .where(and(eq(reviews.isBenchmark, true), gte(reviews.createdAt, since)))
    .orderBy(sql`${reviews.createdAt} DESC`)
    .limit(60);

  const byRepo = new Map<string, BenchRow[]>();
  for (const r of rows) {
    if (r.owner === null || r.repo === null) continue;
    const key = `${r.owner}/${r.repo}`;
    const cur = byRepo.get(key) ?? [];
    if (cur.length >= FINDINGS_PER_REPO) continue;
    // pull per-row finding_status so we can sniff suggested patches
    const statuses = await db
      .select({
        findingId: findingStatus.findingId,
        suggestedPatch: findingStatus.suggestedPatch,
      })
      .from(findingStatus)
      .where(eq(findingStatus.reviewId, r.reviewId));
    cur.push({
      reviewId: r.reviewId,
      owner: r.owner,
      repo: r.repo,
      prNumber: r.prNumber,
      commitSha: r.commitSha,
      agreementDecision: r.agreementDecision,
      findingStatuses: statuses.map((s) => ({
        findingId: s.findingId,
        suggestedPatch: s.suggestedPatch,
      })),
    });
    byRepo.set(key, cur);
  }

  console.log(`[bench-dryrun] loaded ${rows.length} bench review rows across ${byRepo.size} repos`);

  const reachabilityRecords: ReachabilityRecord[] = [];
  const patchVerifyRecords: PatchVerifyRecord[] = [];
  const liveProtocolMutes: Array<{ owner: string; repo: string; findingTitle: string }> = [];

  let reachabilityBudget = REACHABILITY_BUDGET;
  let patchVerifyBudget = PATCH_VERIFY_BUDGET;

  for (const [key, benchRows] of byRepo.entries()) {
    const [owner, repo] = key.split("/");
    if (owner === undefined || repo === undefined) continue;
    const isLiveLikely = LIVE_MAINNET_REPO_HINTS.some((h) => repo.toLowerCase().includes(h));

    for (const row of benchRows) {
      const findings = extractAgreed(row.agreementDecision);
      const prFiles = await fetchFiles(owner, repo, row.prNumber, row.commitSha);
      for (const finding of findings) {
        if (reachabilityBudget <= 0) break;
        if (finding.severity !== "high" && finding.severity !== "critical") continue;
        reachabilityBudget--;
        try {
          const outcome = await runReachabilityGate({
            finding: {
              title: finding.title,
              category: finding.category as never,
              severity: finding.severity,
              label: "blocking",
              confidence: "high",
              evidence: finding.evidence.map((e) => ({
                path: e.path,
                startLine: e.startLine,
                endLine: e.endLine,
                symbol: null,
                quote: null,
              })),
              reasoning: finding.reasoning ?? "",
              reproduction: finding.reproduction,
              recommendation: finding.recommendation ?? "",
              whyTestsDoNotAlreadyCoverThis: "",
              suggestedRegressionTest: null,
              minimumFixScope: "",
              requiresPolicyReview: false,
              upstreamOrigin: null,
            },
            owner,
            repo,
            // Real PR-changed files when the repo is publicly fetchable.
            // Empty array when the repo is private/404 or the API call
            // failed; reachability degrades to evidence-only signal
            // (still useful, just lower quality).
            files: prFiles,
          });
          const record: ReachabilityRecord = {
            reviewId: row.reviewId,
            owner,
            repo,
            finding,
            verdict: outcome.verdict,
            reason: outcome.reason,
            modelId: outcome.modelId,
            ms: outcome.ms,
            error: outcome.error,
          };
          if (
            outcome.verdict === "reachable" &&
            isLiveLikely &&
            (finding.severity === "high" || finding.severity === "critical")
          ) {
            liveProtocolMutes.push({ owner, repo, findingTitle: finding.title });
          }
          reachabilityRecords.push(record);
          try {
            await recordGateOutcome(row.reviewId, {
              findingId: null,
              stage: "reachability",
              verdict: outcome.verdict,
              evidence: outcome,
              modelId: outcome.modelId,
            });
          } catch (writeErr) {
            console.warn(
              `[bench-dryrun] recordGateOutcome (reachability) skipped — migration 0041 likely not applied: ${
                (writeErr as Error).message
              }`,
            );
          }
        } catch (err) {
          console.warn(`[bench-dryrun] reachability gate threw: ${(err as Error).message}`);
        }
      }

      for (const status of row.findingStatuses) {
        if (patchVerifyBudget <= 0) break;
        if (status.suggestedPatch === null) continue;
        // Pair the finding_status row with the corresponding agreed
        // finding by index. finding_id is `<short>-<index>` (per
        // makeFindingId); decoding the trailing integer is the cheapest
        // way to thread evidence into the verifier without re-querying.
        const idx = parseFindingIndex(status.findingId);
        const agreed = idx !== null ? findings[idx] : undefined;
        patchVerifyBudget--;
        try {
          const outcome = await runPatchVerifier({
            repoUrl: `https://github.com/${owner}/${repo}.git`,
            sha: row.commitSha,
            patch: status.suggestedPatch,
            finding: {
              title: agreed?.title ?? "(bench replay)",
              category: (agreed?.category as never) ?? ("logic" as never),
              severity: agreed?.severity ?? "low",
              label: "blocking",
              confidence: "low",
              evidence: (agreed?.evidence ?? []).map((e) => ({
                path: e.path,
                startLine: e.startLine,
                endLine: e.endLine,
                symbol: null,
                quote: null,
              })),
              reasoning: agreed?.reasoning ?? "",
              reproduction: agreed?.reproduction ?? null,
              recommendation: agreed?.recommendation ?? "",
              whyTestsDoNotAlreadyCoverThis: "",
              suggestedRegressionTest: null,
              minimumFixScope: "",
              requiresPolicyReview: false,
              upstreamOrigin: null,
            },
            io: realPatchVerifierIo(),
          });
          patchVerifyRecords.push({
            reviewId: row.reviewId,
            owner,
            repo,
            findingId: status.findingId,
            verdict: outcome.verdict,
            detector: outcome.detector,
            notes: outcome.notes,
            ms: outcome.ms,
          });
          try {
            await recordGateOutcome(row.reviewId, {
              findingId: status.findingId,
              stage: "patch_verify",
              verdict: outcome.verdict,
              evidence: outcome,
              modelId: null,
            });
          } catch (writeErr) {
            console.warn(
              `[bench-dryrun] recordGateOutcome (patch_verify) skipped — migration 0041 likely not applied: ${
                (writeErr as Error).message
              }`,
            );
          }
        } catch (err) {
          console.warn(`[bench-dryrun] patch verifier threw: ${(err as Error).message}`);
        }
      }
    }
  }

  const reportPath = resolve(selfDir, "../../../.omc/research/daybreak-gates-bench-evidence.md");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    renderReport({
      benchRowCount: rows.length,
      benchRepoCount: byRepo.size,
      reachabilityRecords,
      patchVerifyRecords,
      liveProtocolMutes,
      reachabilityBudget,
      patchVerifyBudget,
    }),
    "utf8",
  );
  console.log(`[bench-dryrun] report written to ${reportPath}`);
}

function parseFindingIndex(findingId: string): number | null {
  const m = /-(\d+)$/u.exec(findingId);
  if (m === null) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractAgreed(agreementDecision: unknown): AgreedFinding[] {
  if (agreementDecision === null || typeof agreementDecision !== "object") return [];
  const obj = agreementDecision as Record<string, unknown>;
  const agreed = obj["agreed"];
  if (!Array.isArray(agreed)) return [];
  const out: AgreedFinding[] = [];
  for (const item of agreed) {
    if (item === null || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    const title = typeof f["title"] === "string" ? f["title"] : null;
    const category = typeof f["category"] === "string" ? f["category"] : null;
    const severity = f["severity"];
    if (title === null || category === null) continue;
    if (
      severity !== "critical" &&
      severity !== "high" &&
      severity !== "medium" &&
      severity !== "low"
    ) {
      continue;
    }
    const evidence = Array.isArray(f["evidence"]) ? f["evidence"] : [];
    out.push({
      title,
      category,
      severity,
      evidence: evidence
        .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
        .map((e) => ({
          path: typeof e["path"] === "string" ? e["path"] : "",
          startLine: typeof e["startLine"] === "number" ? e["startLine"] : null,
          endLine: typeof e["endLine"] === "number" ? e["endLine"] : null,
        })),
      reasoning: typeof f["reasoning"] === "string" ? f["reasoning"] : "",
      reproduction: typeof f["reproduction"] === "string" ? f["reproduction"] : null,
      recommendation: typeof f["recommendation"] === "string" ? f["recommendation"] : "",
    });
  }
  return out;
}

function renderReport(args: {
  benchRowCount: number;
  benchRepoCount: number;
  reachabilityRecords: ReachabilityRecord[];
  patchVerifyRecords: PatchVerifyRecord[];
  liveProtocolMutes: Array<{ owner: string; repo: string; findingTitle: string }>;
  reachabilityBudget: number;
  patchVerifyBudget: number;
}): string {
  const byRepo = new Map<
    string,
    {
      reachable: number;
      unreachable: number;
      uncertain: number;
      verified: number;
      regressed: number;
      inconclusive: number;
    }
  >();
  const tally = (key: string) =>
    byRepo.get(key) ?? {
      reachable: 0,
      unreachable: 0,
      uncertain: 0,
      verified: 0,
      regressed: 0,
      inconclusive: 0,
    };

  for (const r of args.reachabilityRecords) {
    const k = `${r.owner}/${r.repo}`;
    const t = tally(k);
    t[r.verdict]++;
    byRepo.set(k, t);
  }
  for (const r of args.patchVerifyRecords) {
    const k = `${r.owner}/${r.repo}`;
    const t = tally(k);
    t[r.verdict]++;
    byRepo.set(k, t);
  }

  const reachabilityErrors = args.reachabilityRecords.filter((r) => r.error !== null);
  const auth401 = reachabilityErrors.filter(
    (r) => r.error !== null && r.error.includes("401") && r.error.includes("authentication_error"),
  );
  const patchApplyFails = args.patchVerifyRecords.filter((r) =>
    r.notes.includes("git apply failed"),
  );

  const lines: string[] = [];
  lines.push("# Daybreak gates — bench dry-run evidence");
  lines.push("");
  lines.push(`Generated: bench dry-run script`);
  lines.push(
    `Scope: ${args.benchRowCount} recent bench reviews across ${args.benchRepoCount} bench repos.`,
  );
  lines.push("");
  lines.push("## How to read this");
  lines.push("");
  lines.push(
    "The dry-run is an *end-to-end wiring proof*, not a substantive call on the bench corpus. It demonstrates that (a) the flag check fires, (b) both gates execute their pure paths against real bench data, (c) the fail-open behavior engages on upstream errors, and (d) the gate-outcomes side-table write is attempted (and degrades gracefully when migration 0041 has not been applied).",
  );
  if (auth401.length > 0) {
    lines.push("");
    lines.push(
      `**Auth fail-open notice.** ${auth401.length}/${args.reachabilityRecords.length} reachability calls landed on \`uncertain\` because the local Anthropic API key returned 401. The verdicts in the table below therefore reflect the fail-open path, not Haiku's substantive answer. To reach the gate's discriminative output, swap the local \`ANTHROPIC_API_KEY\` for a valid one and re-run.`,
    );
  }
  const adapterRefusals = args.patchVerifyRecords.filter((r) =>
    r.notes.includes("patch-adapter could not normalise"),
  );
  if (patchApplyFails.length > 0 || adapterRefusals.length > 0) {
    lines.push("");
    const note =
      "**Patch-verifier adapter active.** " +
      "Stored `suggested_patch` rows are rebuilt by `patch-adapter.ts` (recomputes " +
      "the `diff --git` envelope and re-anchors the hunk against the file at the " +
      "reviewed SHA). " +
      `${adapterRefusals.length}/${args.patchVerifyRecords.length} calls were safely ` +
      "refused as `inconclusive` because the patch's old-side block could not be " +
      "located in the evidence file — the proposed fix may target a different " +
      `version of the file. ${patchApplyFails.length}/${args.patchVerifyRecords.length} ` +
      "still hit `git apply` errors after rebuild; the residual failures are usually " +
      "whitespace drift between the patch's old-side text and the actual file lines " +
      "(future work: anchor-line substitution in the rebuild step). Either way, the " +
      "gate refuses to ship; the prod flag flip is now bounded by adapter quality " +
      "rather than format-level rejection.";
    lines.push(note);
  }
  lines.push("");
  lines.push("## Reachability gate");
  lines.push("");
  lines.push(
    `Calls made: ${args.reachabilityRecords.length} / cap ${args.reachabilityRecords.length + args.reachabilityBudget}`,
  );
  lines.push("");
  lines.push("| Repo | reachable | unreachable | uncertain |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [k, t] of byRepo.entries()) {
    if (t.reachable + t.unreachable + t.uncertain === 0) continue;
    lines.push(`| ${k} | ${t.reachable} | ${t.unreachable} | ${t.uncertain} |`);
  }
  if (args.reachabilityRecords.length === 0) {
    lines.push("");
    lines.push(
      "_No HIGH/CRITICAL agreed findings in the bench window — no reachability calls fired. The gate code paths still ran their flag and budget checks; the evidence here is end-to-end clean rather than statistical._",
    );
  }
  lines.push("");
  const disagreements = args.reachabilityRecords.filter((r) => r.verdict === "unreachable");
  if (disagreements.length > 0) {
    lines.push("### Reachability vs consensus disagreements (HIGH/CRITICAL downgraded)");
    lines.push("");
    for (const r of disagreements) {
      const ev = r.finding.evidence[0];
      const where = ev !== undefined ? `${ev.path}:${ev.startLine ?? "?"}` : "(no evidence)";
      lines.push(`- **${r.owner}/${r.repo}** — \`${where}\` — ${r.finding.title}`);
      lines.push(`  - severity (consensus): ${r.finding.severity}`);
      lines.push(`  - verdict: unreachable`);
      lines.push(`  - reason: ${r.reason}`);
      lines.push("");
    }
  } else {
    lines.push(
      "_No disagreements between unanimous consensus and reachability gate in this batch._",
    );
    lines.push("");
  }

  lines.push("## Patch verifier");
  lines.push("");
  lines.push(
    `Calls made: ${args.patchVerifyRecords.length} / cap ${args.patchVerifyRecords.length + args.patchVerifyBudget}`,
  );
  lines.push("");
  lines.push("| Repo | verified | regressed | inconclusive |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [k, t] of byRepo.entries()) {
    if (t.verified + t.regressed + t.inconclusive === 0) continue;
    lines.push(`| ${k} | ${t.verified} | ${t.regressed} | ${t.inconclusive} |`);
  }
  if (args.patchVerifyRecords.length === 0) {
    lines.push("");
    lines.push(
      "_No findings with a recorded `suggested_patch` in the bench window — no verifier calls fired. Once the patch agent backfills bench rows, this section populates automatically._",
    );
  } else {
    lines.push("");
    lines.push("### Per-call notes");
    lines.push("");
    for (const r of args.patchVerifyRecords) {
      lines.push(`- **${r.owner}/${r.repo}** finding \`${r.findingId}\` — verdict: ${r.verdict}`);
      lines.push(`  - detector: ${r.detector}`);
      lines.push(`  - notes: ${r.notes}`);
      lines.push("");
    }
  }

  if (args.liveProtocolMutes.length > 0) {
    lines.push("## ⚠ Live-protocol mutes");
    lines.push("");
    lines.push(
      `${args.liveProtocolMutes.length} HIGH-severity reachable verdict(s) on repos whose names hint at live mainnet protocols. Details are intentionally omitted per \`feedback_live_protocol_disclosure\` — the operator must route them through the bug-bounty path before any public PR.`,
    );
    for (const m of args.liveProtocolMutes) {
      lines.push(
        `- ${m.owner}/${m.repo} — finding title redacted (${m.findingTitle.slice(0, 32)}…)`,
      );
    }
    lines.push("");
  }

  lines.push("## What the user reviews before flipping flags");
  lines.push("");
  lines.push(
    "1. Reachability gate ran end-to-end against the bench reviews above; counts surface per repo.",
  );
  lines.push(
    "2. Patch verifier ran end-to-end where the bench data included a `suggested_patch`; verdicts surface per call.",
  );
  lines.push(
    "3. No live-protocol HIGH findings published; any flagged in the mutes section route private.",
  );
  lines.push(
    "4. Prod flags remain OFF — flip via env after this report is reviewed and migration 0041 has been applied to prod.",
  );
  lines.push("");
  return lines.join("\n");
}

main().catch((err) => {
  console.error("[bench-dryrun] fatal:", err);
  process.exit(1);
});
