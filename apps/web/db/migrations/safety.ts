// Default-deny guard for apply-migration-*.ts scripts.
//
// Background: dev and prod share one Neon DB (`ep-crimson-hall-aq6bfx9d`).
// The old `PROD_PATTERNS = ['neon-fulvous-zebra', 'solitary-dew-96858656']`
// list referenced hosts that no longer exist, so the guard protected
// nothing; a few scripts had no guard at all. Replace that pattern with a
// shared default-deny check: any --apply path is refused unless
// ALLOW_PROD_APPLY=1 is explicitly set in the environment.
//
// Dry-run remains unguarded so the existing pattern of running a script
// without --apply to print the SQL stays cheap and side-effect-free.

import { createInterface } from "node:readline";

export function databaseHostForLog(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export type ResolveOk = {
  ok: true;
  url: string;
  host: string;
  apply: boolean;
};
export type ResolveErr = { ok: false; reason: string };
export type ResolveResult = ResolveOk | ResolveErr;

// Parse argv + env into the resolved decision the runner needs. Returned as
// a result object so the caller controls process.exit (and the helper stays
// trivially unit-testable). Treat `apply=true` as authoritative: the caller
// must NOT touch the DB when apply=false, regardless of other flags.
export function resolveApplyPlan(opts: {
  argv: ReadonlyArray<string>;
  env: Record<string, string | undefined>;
}): ResolveResult {
  const apply = opts.argv.includes("--apply");
  const url = opts.env["DATABASE_URL"];
  if (!url) {
    return { ok: false, reason: "DATABASE_URL not set" };
  }
  const host = databaseHostForLog(url);
  if (apply && opts.env["ALLOW_PROD_APPLY"] !== "1") {
    return {
      ok: false,
      reason:
        `REFUSING to apply migration to ${host}: ALLOW_PROD_APPLY=1 not set.\n` +
        "dev and prod share one Neon DB; --apply writes to prod.\n" +
        "Re-run with ALLOW_PROD_APPLY=1 to acknowledge.",
    };
  }
  return { ok: true, url, host, apply };
}

// Convenience wrapper used by every apply-migration-*.ts main(). Returns
// the resolved url/host/apply on success; logs the failure reason and
// exits non-zero (so the script's main() body can read it as the happy
// path). Always echoes the resolved host so an operator sees what they
// are about to mutate, before they make the choice. When --apply is set
// and a TTY is attached, also prompts the operator to retype the host;
// non-TTY contexts (CI) rely solely on the ALLOW_PROD_APPLY env gate.
export async function assertSafeToApply(): Promise<{
  url: string;
  host: string;
  apply: boolean;
}> {
  const result = resolveApplyPlan({ argv: process.argv, env: process.env });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }
  console.log("Target host:", result.host);
  if (result.apply) {
    await confirmHostInteractive(result.host);
  }
  return { url: result.url, host: result.host, apply: result.apply };
}

// Interactive --apply confirmation. Prompts the operator to retype the
// host name; aborts on mismatch. In non-TTY contexts (CI, scripts piped
// from stdin), the env-var gate (ALLOW_PROD_APPLY=1) is the sole gate —
// auto-skipping the prompt keeps unattended applies possible when the
// operator has set the env var, while keeping the typed confirmation as
// belt-and-braces for hand-driven runs.
export async function confirmHostInteractive(host: string): Promise<void> {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Type the host to confirm apply (${host}): `, resolve);
  });
  rl.close();
  if (answer.trim() !== host) {
    console.error("Host confirmation mismatch; aborting.");
    process.exit(1);
  }
}
