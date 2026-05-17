/**
 * Admin tool — dump the newest 15 onboarding_events rows. Companion to
 * inspect-finding-status; same target audience (operator diagnosing
 * Onboarder behavior in prod).
 *
 * Shows: event_type, install + repo, model_id, comment_id/url, the
 * `public` /activity gate, and a truncated tool_output preview. Full
 * prompt and tool_output JSON live in the row but are too verbose to
 * print here — query via psql if you need them.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/inspect-onboarding-events.ts
 *
 * Reads DATABASE_URL from .env.local. Operator-only — row contents
 * include raw owner/repo strings and the agent's tool output (which
 * can quote partner repo names).
 */
import { config as loadDotenv } from "dotenv";
loadDotenv({ path: ".env.local", quiet: true });

async function main() {
  const { db } = await import("../db/index");
  const { onboardingEvents } = await import("../db/schema");
  const { desc } = await import("drizzle-orm");

  const rows = await db
    .select()
    .from(onboardingEvents)
    .orderBy(desc(onboardingEvents.createdAt))
    .limit(15);

  console.log(`\n[onboarding_events rows, newest first — ${rows.length} total]\n`);
  for (const r of rows) {
    console.log(`event_type     : ${r.eventType}`);
    console.log(`  id           : ${r.id}`);
    console.log(`  owner/repo   : ${r.owner}/${r.repo}`);
    console.log(`  install_id   : ${r.installationId}`);
    console.log(`  model_id     : ${r.modelId ?? "—"}`);
    console.log(`  comment_id   : ${r.commentId ?? "—"}`);
    console.log(`  comment_url  : ${r.commentUrl ?? "—"}`);
    console.log(`  public       : ${r.public}`);
    console.log(`  created_at   : ${r.createdAt.toISOString()}`);
    const toolOut = JSON.stringify(r.toolOutput);
    const preview = toolOut.length > 120 ? `${toolOut.slice(0, 120)}…` : toolOut;
    console.log(`  tool_output  : ${preview}`);
    console.log("");
  }
  if (rows.length === 0) {
    console.log("(no rows — either Onboarder hasn't fired yet or ONBOARDER_ENABLED is off)\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
