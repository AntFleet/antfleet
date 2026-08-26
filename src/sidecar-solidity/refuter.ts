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

export const refutationOutputSchema = z.object({
  verdict: z.enum(["KILLED", "SURVIVED"]).catch("KILLED"),
  reason: z.string().catch("refutation output unparseable"),
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
  contextNote?: string | undefined;
};

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
    contextNote: args.contextNote,
  });
  const handled = await callModel(prompt);
  const parsed = refutationOutputSchema.safeParse(handled);
  if (!parsed.success) {
    throw new Error(`refutation output failed lenient parse: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Production adapter: wraps the shared transport for use as `callModel`. */
export async function refuterTransport(prompt: string): Promise<unknown> {
  const { payload } = await refuteModelCall(prompt);
  return payload;
}
