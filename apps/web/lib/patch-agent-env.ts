// Patch Agent v1.5 — env gate.
//
// PR4 needs a single boolean check at the review-worker layer to decide
// whether to invoke the orchestrator + gate at all. The env-only check
// here is the v4 surface; PR6 layers the per-install override
// (installations.patchAgentEnabled) on top.
//
// Defaults:
//   PATCH_AGENT_ENABLED unset OR "false" → disabled
//   "true" / "1" → enabled
//   Anything else → disabled (conservative)
//
// Keeping this isolated in its own module so PR6's expansion can wrap it
// without touching the worker.

export function isPatchAgentEnabled(): boolean {
  const raw = process.env["PATCH_AGENT_ENABLED"];
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase().trim();
  return normalized === "true" || normalized === "1";
}
