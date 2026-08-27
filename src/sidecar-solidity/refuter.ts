// Component C — independent adversarial refuter pass (REWORK_PROMPT item 1).
//
// A finding reaches PURSUE only if it survives a SECOND, separate model call
// whose sole job is to KILL it. The refuter is a distinct prompt/role — the
// finder never re-grades its own candidates. Same transport, same spend gates:
// refuter calls happen only in --live mode (dry-run never promotes, see
// scoring.ts promote()).

import { z } from "zod";
import type { PromptFile } from "./prompt.js";
import { buildRefuterPrompt } from "./prompt.js";
import { refuteModelCall } from "./model-client.js";
import { groundOffChainClaim, renderTrustCorpus, type ContextPack } from "./context-pack.js";

export const refutationOutputSchema = z.object({
  verdict: z.enum(["KILLED", "SURVIVED"]).catch("KILLED"),
  reason: z.string().catch("refutation output unparseable"),
  // Phase 0: present only on an off-chain / documented kill; mechanically grounded.
  offChainEvidence: z
    .object({ source: z.string().catch(""), quote: z.string().catch("") })
    .nullish()
    .catch(null),
});

export type Refutation = z.infer<typeof refutationOutputSchema>;

export type RefuteFindingArgs = {
  finding: {
    title: string;
    severity: string;
    reasoning: string;
    evidence: readonly { path: string; startLine: number | null; endLine: number | null }[];
    triggerRole?: string | undefined;
    preconditions?: string | undefined;
  };
  files: readonly PromptFile[];
  programRules: string;
  /** Supplied corpus of known/public findings for duplicate detection. */
  priorFindings?: readonly string[] | undefined;
  /** Phase 0 ADJUDICATIVE context — enables + grounds off-chain kill-grounds. */
  contextPack?: ContextPack | undefined;
  contextNote?: string | undefined;
};

// Literal off-chain ground labels — used to catch a kill that names ground 6/7
// but omits the required grounded quote (the dodge). Deliberately tight so a
// normal PRIVILEGED-GATED reason that merely mentions "guardian" is NOT caught.
const OFFCHAIN_GROUND_LABEL = /off-?chain-?mitigated|documented\s*\/?\s*known/iu;

/** True when a KILLED verdict rests on an off-chain / documented ground. */
export function isOffChainKill(reason: string, evidencePresent: boolean): boolean {
  return evidencePresent || OFFCHAIN_GROUND_LABEL.test(reason);
}

/**
 * Run one adversarial refutation. `callModel` is injectable so tests run with
 * fakes; production passes a thin wrapper over refuteModelCall. A transport or
 * parse failure is surfaced as KILLED-with-reason? No — it THROWS: an
 * infrastructure failure must not be laundered into either verdict.
 */
export async function refuteFinding(
  args: RefuteFindingArgs,
  callModel?: ((prompt: string) => Promise<unknown>) | undefined,
): Promise<Refutation> {
  if (callModel === undefined) {
    // Dry-run: no model spend. Callers must not treat this as SURVIVED; run.ts
    // composes via promote() which caps at "awaiting refuter" DROP.
    return { verdict: "KILLED", reason: "refuter pass not executed (dry-run)" };
  }
  const prompt = buildRefuterPrompt({
    finding: args.finding,
    files: args.files,
    programRules: args.programRules,
    priorFindings: args.priorFindings ?? [],
    trustModelContext:
      args.contextPack === undefined ? undefined : renderTrustCorpus(args.contextPack),
    contextNote: args.contextNote,
  });
  const handled = await callModel(prompt);
  const parsed = refutationOutputSchema.safeParse(handled);
  if (!parsed.success) {
    throw new Error(`refutation output failed lenient parse: ${parsed.error.message}`);
  }
  return applyOffChainGuardrail(parsed.data, args.contextPack);
}

/**
 * THE GUARDRAIL (specs/SOLIDITY_SIDECAR_PHASE0_SPEC.md). An off-chain / documented
 * KILL is trusted only if its cited quote is mechanically found in the trust
 * corpus. An ungrounded off-chain kill is flipped to SURVIVED — fail-safe toward
 * keeping the finding for human review. On-chain kills (no off-chain evidence,
 * no off-chain ground label) pass through untouched, so the no-Phase-0 path is
 * unaffected.
 */
export function applyOffChainGuardrail(
  refutation: Refutation,
  pack: ContextPack | undefined,
): Refutation {
  if (refutation.verdict !== "KILLED") {
    return refutation;
  }
  const evidence = refutation.offChainEvidence ?? null;
  if (!isOffChainKill(refutation.reason, evidence !== null)) {
    return refutation; // on-chain kill — unchanged
  }
  const grounded = pack !== undefined && groundOffChainClaim(evidence?.quote, pack);
  if (grounded) {
    return refutation;
  }
  return {
    verdict: "SURVIVED",
    reason: `off-chain/documented kill NOT grounded in the supplied docs/audits (quote not found) — kept for human review. Original refuter reason: ${refutation.reason}`,
    offChainEvidence: null,
  };
}

/** Production adapter: wraps the shared transport for use as `callModel`. */
export async function refuterTransport(prompt: string): Promise<unknown> {
  const { payload } = await refuteModelCall(prompt);
  return payload;
}
