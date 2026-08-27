// Phase 0 — Context assembly (pre-detect ingestion).
// specs/SOLIDITY_SIDECAR_PHASE0_SPEC.md
//
// Ingests OFF-CHAIN ground truth the on-chain closure cannot show — repo docs +
// NatSpec, audit-report text, and an operator trust-model file — and routes it
// ASYMMETRICALLY:
//   - DESCRIPTIVE `systemBrief` -> finder/slice/confirm (understand the system +
//     its off-chain actors; NEVER a list of what to dismiss — protects recall).
//   - ADJUDICATIVE `trustCorpus` + `knownIssues` -> the refuter (new
//     OFF-CHAIN-MITIGATED / DOCUMENTED / DUPLICATE kill-grounds).
//
// GUARDRAIL (see groundOffChainClaim + refuter.ts): an off-chain kill is accepted
// only if the refuter cites a quote that MECHANICALLY occurs in trustCorpus —
// unsupported off-chain dismissals are flipped back to SURVIVED. Same rigor as
// on-chain evidence grounding; docs are UNTRUSTED and a bare "this is safe" with
// no mechanism grounds nothing.

import { readFile as fsReadFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { PromptFile } from "./prompt.js";

export type ContextSourceKind = "doc" | "natspec" | "audit" | "trust-model";
export type ContextSource = { path: string; kind: ContextSourceKind };

export type ContextPack = {
  /** DESCRIPTIVE brief for the finder — how the system works + off-chain actors. Lean. */
  systemBrief: string;
  /** ADJUDICATIVE corpus for the refuter — docs + trust-model + audit text. Grounds off-chain kills. */
  trustCorpus: string;
  /** Known/accepted issues (from audits) → refuter DUPLICATE corpus. */
  knownIssues: string[];
  sources: ContextSource[];
};

/** An empty pack — Phase 0 disabled / no off-chain sources. Behaves as pre-Phase-0. */
export const EMPTY_CONTEXT_PACK: ContextPack = {
  systemBrief: "",
  trustCorpus: "",
  knownIssues: [],
  sources: [],
};

export function isEmptyPack(pack: ContextPack): boolean {
  return (
    pack.systemBrief.length === 0 && pack.trustCorpus.length === 0 && pack.knownIssues.length === 0
  );
}

const DEFAULT_BRIEF_BUDGET = 12_000;
const DEFAULT_CORPUS_BUDGET = 48_000;
/** A quote shorter than this cannot ground an off-chain kill (too weak an anchor). */
export const MIN_OFFCHAIN_QUOTE_LEN = 16;

// Off-chain actors / trust-boundary vocabulary. A NatSpec line mentioning one of
// these is a trust-model hint worth surfacing to both the finder (descriptively)
// and the refuter (adjudicatively).
const OFF_CHAIN_ACTOR_TERMS = [
  "guardian",
  "paymaster",
  "keeper",
  "sequencer",
  "relayer",
  "off-chain",
  "offchain",
  "off chain",
  "attestation",
  "enclave",
  "watchtower",
  "watcher",
  "oracle updater",
  "signer",
  "operator",
  "bot",
];

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function mentionsOffChainActor(line: string): boolean {
  const lower = line.toLowerCase();
  return OFF_CHAIN_ACTOR_TERMS.some((t) => lower.includes(t));
}

const NATSPEC_LINE = /^\s*(?:\/\/\/|\*|\/\*\*?|\/\/)?\s*@?(notice|dev|param|title|author)?\b/iu;

/**
 * Extract NatSpec / doc-comment lines that mention an off-chain actor from the
 * closure files. Pure. These are the highest-signal, most compact trust hints —
 * e.g. GuardianModule's "validation of guardian's EOA/Enclave signatures".
 * Returns `path :: line` strings, de-duplicated, capped.
 */
export function extractNatSpecTrustHints(
  files: readonly PromptFile[],
  cap = 60,
): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const raw of file.contents.split(/\r?\n/u)) {
      const trimmed = raw.trim();
      // Comment lines only (NatSpec `///`, block `*`, or `//`), mentioning an actor.
      const isComment =
        trimmed.startsWith("///") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/**") ||
        trimmed.startsWith("//") ||
        (NATSPEC_LINE.test(trimmed) && trimmed.includes("@"));
      if (!isComment || !mentionsOffChainActor(trimmed)) {
        continue;
      }
      const text = normalizeWhitespace(trimmed.replace(/^[/*\s]+/u, ""));
      if (text.length < 12) {
        continue;
      }
      const key = `${file.path}::${text}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ path: file.path, text });
      if (out.length >= cap) {
        return out;
      }
    }
  }
  return out;
}

/**
 * Best-effort extraction of discrete audit findings from extracted audit text, to
 * seed the refuter's DUPLICATE corpus. Pure. Matches severity-tagged / numbered
 * finding headers (`[High] ...`, `6.1 [Medium] ...`, `Finding 3: ...`). Crude by
 * design — precision is the refuter's job; this only supplies candidates.
 */
export function extractKnownIssues(
  auditTexts: readonly { name: string; text: string }[],
  cap = 80,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const header =
    /(\[(?:critical|high|medium|low|informational|info|qa)\][^\n]{0,160})|((?:finding|issue)\s*#?\d+[:.-][^\n]{0,160})/giu;
  for (const audit of auditTexts) {
    for (const m of audit.text.matchAll(header)) {
      const label = normalizeWhitespace(m[0] ?? "");
      if (label.length < 6) {
        continue;
      }
      const entry = `${audit.name}: ${label}`;
      if (seen.has(entry.toLowerCase())) {
        continue;
      }
      seen.add(entry.toLowerCase());
      out.push(entry);
      if (out.length >= cap) {
        return out;
      }
    }
  }
  return out;
}

/** Concatenate sections up to a byte budget, marking where content was cut. */
function budgeted(sections: readonly string[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const s of sections) {
    if (s.length === 0) {
      continue;
    }
    if (used + s.length > budget) {
      const room = budget - used;
      if (room > 200) {
        out.push(`${s.slice(0, room)}\n…[context truncated to budget]`);
      } else {
        out.push("…[further context omitted — budget reached]");
      }
      break;
    }
    out.push(s);
    used += s.length;
  }
  return out.join("\n\n");
}

export type ContextPackInputs = {
  /** Repo doc/markdown files (README, docs/**). */
  docs?: readonly { path: string; text: string }[];
  /** NatSpec off-chain-actor hint lines (from extractNatSpecTrustHints). */
  natspecHints?: readonly { path: string; text: string }[];
  /** Operator-extracted audit-report text (PDFs -> text out of process). */
  auditTexts?: readonly { name: string; text: string }[];
  /** Operator --trust-model file contents. */
  trustModelText?: string | undefined;
  briefBudgetBytes?: number;
  corpusBudgetBytes?: number;
};

/**
 * Assemble a ContextPack from already-read inputs. PURE (no FS). The systemBrief
 * is intentionally LEAN (NatSpec hints + trust-model + a bounded docs head) so it
 * does not bloat the finder prompt or crowd the closure's byte budget; the
 * trustCorpus is the fuller adjudicative body the refuter grounds kills against.
 */
export function buildContextPack(inputs: ContextPackInputs): ContextPack {
  const docs = inputs.docs ?? [];
  const hints = inputs.natspecHints ?? [];
  const audits = inputs.auditTexts ?? [];
  const trustModel = inputs.trustModelText?.trim() ?? "";
  const briefBudget = inputs.briefBudgetBytes ?? DEFAULT_BRIEF_BUDGET;
  const corpusBudget = inputs.corpusBudgetBytes ?? DEFAULT_CORPUS_BUDGET;

  const sources: ContextSource[] = [
    ...docs.map((d) => ({ path: d.path, kind: "doc" as const })),
    ...(hints.length > 0 ? [{ path: "(closure NatSpec)", kind: "natspec" as const }] : []),
    ...audits.map((a) => ({ path: a.name, kind: "audit" as const })),
    ...(trustModel.length > 0 ? [{ path: "(--trust-model)", kind: "trust-model" as const }] : []),
  ];

  const hintsBlock =
    hints.length > 0
      ? `OFF-CHAIN ACTOR NOTES (from contract NatSpec):\n${hints.map((h) => `- ${h.path}: ${h.text}`).join("\n")}`
      : "";
  const docsBlock =
    docs.length > 0 ? docs.map((d) => `## ${d.path}\n${d.text.trim()}`).join("\n\n") : "";
  const trustModelBlock =
    trustModel.length > 0 ? `OPERATOR TRUST MODEL (trusted operator input):\n${trustModel}` : "";
  const auditBlock =
    audits.length > 0
      ? audits.map((a) => `## AUDIT: ${a.name}\n${a.text.trim()}`).join("\n\n")
      : "";

  // Brief (finder): trust-model + NatSpec hints first (highest signal, always
  // kept), then a bounded head of the docs.
  const systemBrief = budgeted([trustModelBlock, hintsBlock, docsBlock], briefBudget);
  // Corpus (refuter): the fuller adjudicative body — docs + trust-model + audits.
  const trustCorpus = budgeted([trustModelBlock, docsBlock, hintsBlock, auditBlock], corpusBudget);
  const knownIssues = extractKnownIssues(audits);

  return { systemBrief, trustCorpus, knownIssues, sources };
}

// --- FS collectors (CLI convenience; pure builders above stay test-friendly) --

const DOC_SKIP_DIRS = new Set(["node_modules", "out", "cache", ".git", ".fleet", "lib"]);

/**
 * List markdown documentation under a repo root: any `README*.md` plus everything
 * under a `docs/` directory. Skips deps/build output. Repo-relative, sorted.
 */
export async function listMarkdownDocs(root: string): Promise<string[]> {
  const acc: string[] = [];
  const walk = async (dir: string, underDocs: boolean): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || DOC_SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, underDocs || entry.name.toLowerCase() === "docs");
      } else if (/\.(?:md|markdown|txt)$/iu.test(entry.name)) {
        // Keep README* anywhere near the top, and anything under a docs/ tree.
        if (underDocs || /^readme/iu.test(entry.name)) {
          acc.push(relative(root, full));
        }
      }
    }
  };
  await walk(root, false);
  return acc.toSorted();
}

/** List operator-extracted audit text files (.txt/.md) in a directory. Repo/abs. */
export async function listAuditTexts(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && /\.(?:txt|md)$/iu.test(e.name))
      .map((e) => join(dir, e.name))
      .toSorted();
  } catch {
    return [];
  }
}

/** Read a UTF-8 file, returning "" on any error (missing docs are non-fatal). */
export async function readTextFileSafe(path: string): Promise<string> {
  return fsReadFile(path, "utf8").catch(() => "");
}

/** Whitespace-normalized substring check: is `quote` present in `text`? */
function corpusContains(text: string, quote: string): boolean {
  const q = normalizeWhitespace(quote);
  if (q.length < MIN_OFFCHAIN_QUOTE_LEN) {
    return false;
  }
  return normalizeWhitespace(text).includes(q);
}

/**
 * THE GUARDRAIL. An off-chain / documented kill is only trustworthy if the cited
 * quote actually occurs in the trust corpus. Returns true when grounded. A quote
 * that is too short, empty, or absent from the corpus is NOT grounded — the
 * refuter's kill on that basis must be rejected (flipped to SURVIVED in refuter.ts).
 */
export function groundOffChainClaim(quote: string | null | undefined, pack: ContextPack): boolean {
  if (quote === null || quote === undefined || quote.trim().length === 0) {
    return false;
  }
  return corpusContains(pack.trustCorpus, quote);
}

// --- Prompt-facing bodies ----------------------------------------------------
// These return ONLY the untrusted documentation body. The trusted framing
// (how to use it) and the nonce fence are added by prompt.ts, so operator/repo
// text can never sit outside a fence or masquerade as instructions.

/**
 * DESCRIPTIVE system-context body for the finder — empty when there is nothing to
 * say. `entryHints` (optional) are per-entry NatSpec off-chain-actor lines from
 * THIS entry's closure, appended so a sweep can build the pack once (docs) yet
 * still surface each contract's own trust hints.
 */
export function renderSystemBrief(
  pack: ContextPack,
  entryHints: readonly { path: string; text: string }[] = [],
): string {
  const hintsBlock =
    entryHints.length > 0
      ? `OFF-CHAIN ACTOR NOTES (from this contract's NatSpec):\n${entryHints.map((h) => `- ${h.path}: ${h.text}`).join("\n")}`
      : "";
  return [pack.systemBrief, hintsBlock].filter((s) => s.length > 0).join("\n\n");
}

/** ADJUDICATIVE trust-corpus body for the refuter — empty when no pack. */
export function renderTrustCorpus(pack: ContextPack): string {
  return pack.trustCorpus;
}
