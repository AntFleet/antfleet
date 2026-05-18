/**
 * Admin tool — push selected env vars from apps/web/.env.local into the
 * Vercel production environment. Values are piped to `vercel env add`
 * via stdin so they never appear on the command line, in shell history,
 * in process listings, or in this script's stdout.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/push-prod-env.ts <VAR_NAME> [<VAR_NAME> ...]
 *
 * Example:
 *   pnpm exec tsx scripts/push-prod-env.ts GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY \
 *     GITHUB_APP_WEBHOOK_SECRET ANTHROPIC_API_KEY OPENAI_API_KEY
 *
 * Idempotent: when a var already exists in production, the script retries
 * with --force to overwrite. Reports per-var status (ok / skipped / fail);
 * never prints the value itself. Requires `vercel` CLI on PATH and an
 * already-authenticated session bound to this project (.vercel/ present).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

import { spawn } from "node:child_process";

type RunResult = { code: number; stderr: string };

function runVercel(name: string, value: string, force: boolean): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = ["env", "add", name, "production", "--yes"];
    if (force) args.push("--force");
    const child = spawn("vercel", args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
    child.stdin.write(value);
    child.stdin.end();
  });
}

async function pushOne(name: string): Promise<void> {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    console.log(`[skip] ${name}: not present in .env.local`);
    return;
  }

  const initial = await runVercel(name, value, false);
  if (initial.code === 0) {
    console.log(`[ok]   ${name}: added (len=${value.length})`);
    return;
  }

  // Vercel CLI signals "already exists" with various phrasings across
  // versions. Detect broadly and retry with --force.
  if (/already exists|already defined/i.test(initial.stderr)) {
    const forced = await runVercel(name, value, true);
    if (forced.code === 0) {
      console.log(`[ok]   ${name}: overwritten (len=${value.length})`);
      return;
    }
    console.error(`[fail] ${name}: --force retry exited ${forced.code}: ${forced.stderr.trim()}`);
    return;
  }

  console.error(`[fail] ${name}: vercel exited ${initial.code}: ${initial.stderr.trim()}`);
}

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("usage: pnpm exec tsx scripts/push-prod-env.ts <VAR_NAME> [<VAR_NAME> ...]");
    process.exit(2);
  }
  console.log(`[plan] pushing ${names.length} var(s) to production env`);
  for (const name of names) {
    await pushOne(name);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
