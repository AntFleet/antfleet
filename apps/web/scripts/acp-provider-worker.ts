#!/usr/bin/env tsx
// Drain Virtuals ACP CLI events into AntFleet's existing review_jobs worker.
//
// Run alongside:
//   acp events listen --output .acp/events.jsonl --json
//
// Then invoke this script periodically or as a lightweight loop:
//   pnpm --dir apps/web exec tsx scripts/acp-provider-worker.ts --file .acp/events.jsonl

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { handleAcpProviderEvent } from "@/lib/acp/intake-adapter";

const execFileAsync = promisify(execFile);

async function main() {
  const file = readFlag("--file") ?? process.env["ACP_EVENTS_FILE"] ?? ".acp/events.jsonl";
  const limit = readFlag("--limit") ?? "20";
  const events = await drainEvents(file, limit);
  for (const event of events) {
    const outcome = await handleAcpProviderEvent(event);
    console.log(JSON.stringify({ event: event.type ?? event.event ?? "unknown", outcome }));
  }
}

async function drainEvents(file: string, limit: string): Promise<Array<Record<string, unknown>>> {
  const { stdout } = await execFileAsync(
    "acp",
    ["events", "drain", "--file", file, "--limit", limit],
    {
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    },
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
