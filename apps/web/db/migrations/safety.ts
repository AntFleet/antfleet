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
//
// Dry-run path (no --apply) is intentionally permissive about DATABASE_URL.
// Callers print SQL and exit without touching the DB; requiring an env var
// just to read the script breaks the documented review workflow.
export function resolveApplyPlan(opts: {
  argv: ReadonlyArray<string>;
  env: Record<string, string | undefined>;
}): ResolveResult {
  const apply = opts.argv.includes("--apply");
  const url = opts.env["DATABASE_URL"];
  if (!apply) {
    return {
      ok: true,
      url: url ?? "",
      host: url !== undefined ? databaseHostForLog(url) : "(dry-run, no DATABASE_URL)",
      apply: false,
    };
  }
  if (!url) {
    return { ok: false, reason: "DATABASE_URL not set" };
  }
  const host = databaseHostForLog(url);
  if (opts.env["ALLOW_PROD_APPLY"] !== "1") {
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

// Split a SQL script into individual statements.
//
// Why: the prior per-migration splitter just split on `;`. That breaks any
// statement containing a semicolon inside a string literal — e.g. the
// COMMENT body in 0047 had `";"` inside the quoted text and the migration
// aborted mid-run with `unterminated quoted string`.
//
// This helper tracks SQL lexical state so semicolons inside strings or
// comments do NOT terminate a statement. Handled:
//   - single-quoted strings, with `''` as the embedded-quote escape;
//   - dollar-quoted strings with arbitrary tags including the empty tag,
//     e.g. `$$body$$`, `$func$body$func$`;
//   - line comments `-- ...` (stripped to end of line);
//   - block comments `/* ... */` (PostgreSQL block comments do NOT nest in
//     SQL strings but DO nest as comments — we accept the simple
//     non-nesting form since none of our migrations rely on nesting).
//
// Double-quoted identifiers (e.g. `"sarif_finding"`) are NOT treated as
// strings — they cannot contain a literal `;` per SQL spec, so leaving
// them in the default branch is safe.
export function splitSqlStatements(sqlText: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  const len = sqlText.length;

  while (i < len) {
    const ch = sqlText[i];
    const next = i + 1 < len ? sqlText[i + 1] : "";

    if (ch === "-" && next === "-") {
      const nl = sqlText.indexOf("\n", i);
      i = nl === -1 ? len : nl;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = sqlText.indexOf("*/", i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    if (ch === "'") {
      buf += ch;
      i += 1;
      while (i < len) {
        const c = sqlText[i];
        buf += c;
        if (c === "'") {
          if (sqlText[i + 1] === "'") {
            buf += sqlText[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlText.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        buf += tag;
        i += tag.length;
        const end = sqlText.indexOf(tag, i);
        if (end === -1) {
          buf += sqlText.slice(i);
          i = len;
        } else {
          buf += sqlText.slice(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }

    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = "";
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}
