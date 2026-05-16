import type { Finding } from "./review-types";

// Mission 3 slice 3-5 — JSONB extraction helpers for the sweep orchestrator.
// `reviews.agreement_decision` is jsonb and carries one of:
//   { status: "pending" | "skipped" | "error", ... } — the stub/no-op shapes
//   { mode, agreed: Finding[], disagreements, degraded, degradedReason } — the
//     production shape written when the review pipeline completes.
// The sweep cares only about the second shape; everything else is silently
// skipped (the row has no agreed findings to reconcile).
//
// Pure, type-guarded, no DB / no network — split for testability per the
// pattern in sweeper.ts.

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isNumberOrNull(x: unknown): x is number | null {
  return x === null || typeof x === "number";
}

function isFinding(x: unknown): x is Finding {
  if (!isRecord(x)) return false;
  // Required scalar fields — same set the prompt schema enforces upstream, so
  // anything missing here is a corruption signal, not a normal shape.
  if (!isString(x["title"])) return false;
  if (!isString(x["category"])) return false;
  if (!isString(x["severity"])) return false;
  if (!isString(x["reasoning"])) return false;
  if (!isString(x["recommendation"])) return false;
  // Evidence must be a non-empty array of {path, startLine, endLine}; without
  // a path, closure detection can't decide whether the file changed.
  const evidence = x["evidence"];
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  for (const ev of evidence) {
    if (!isRecord(ev)) return false;
    if (!isString(ev["path"])) return false;
    if (!isNumberOrNull(ev["startLine"])) return false;
    if (!isNumberOrNull(ev["endLine"])) return false;
  }
  return true;
}

/**
 * Pull the agreed Finding[] out of an agreement_decision JSONB blob.
 *
 * Returns the array on the production shape; returns null on any other shape
 * (status: pending/skipped/error, missing fields, malformed JSONB). null is
 * the "skip this review" signal — the orchestrator treats it as "no work
 * here," not as an error.
 */
export function extractAgreedFindings(agreementDecision: unknown): Finding[] | null {
  if (!isRecord(agreementDecision)) return null;
  const agreed = agreementDecision["agreed"];
  if (!Array.isArray(agreed)) return null;
  const out: Finding[] = [];
  for (const f of agreed) {
    if (!isFinding(f)) return null;
    out.push(f);
  }
  return out;
}

/**
 * Same as extractAgreedFindings but indexed by findingIndex (the position in
 * the agreed[] array at the moment of posting, stored in
 * finding_status.finding_index). Returns null if extraction fails, so the
 * orchestrator can short-circuit a whole review at once instead of mis-
 * mapping findings to indices.
 */
export function extractFindingsByIndex(
  agreementDecision: unknown,
): ReadonlyMap<number, Finding> | null {
  const findings = extractAgreedFindings(agreementDecision);
  if (findings === null) return null;
  return new Map(findings.map((f, i) => [i, f]));
}
