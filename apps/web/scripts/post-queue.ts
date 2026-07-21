/**
 * Operator drain loop for the post_drafts queue (migration 0054).
 * Event pipelines write drafts via lib/post-drafts.ts; nothing auto-posts.
 * Each pending draft prints a prefilled x.com intent URL — clicking it opens
 * the tweet composer, and the human click is the approval.
 *
 * Usage (from apps/web):
 *   pnpm exec tsx scripts/post-queue.ts list
 *   pnpm exec tsx scripts/post-queue.ts show <draft-id>
 *   pnpm exec tsx scripts/post-queue.ts posted <draft-id> [--apply]
 *   pnpm exec tsx scripts/post-queue.ts dismiss <draft-id> [--apply]
 */
import { pathToFileURL } from "node:url";
import { config as loadDotenv } from "dotenv";

const DRAFT = "draft";

type Queryable = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type DraftRow = {
  id: string;
  slug: string;
  title: string;
  body: string;
  source: string;
  created_at: Date | string;
};

type MutationRow = {
  id: string;
  slug: string;
};

type QueueResult =
  | { action: "list"; rows: DraftRow[] }
  | { action: "show"; rows: DraftRow[] }
  | { action: "posted" | "dismiss"; applied: boolean; rows: Array<DraftRow | MutationRow> };

// Same composer-URL shape as components/TweetIntent.tsx — the draft body
// carries its permalink inline, so text + via is the whole post.
export function intentUrl(body: string): string {
  const params = new URLSearchParams({ text: body, via: "AntFleetDev" });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

export async function managePostQueue(
  argv: string[],
  db: Queryable,
  log: Pick<Console, "log"> = console,
): Promise<QueueResult> {
  const { command, draftId, apply } = parseArgs(argv);

  if (command === "list") {
    const result = await db.query<DraftRow>(
      `SELECT id, slug, title, body, source, created_at
       FROM post_drafts
       WHERE status = $1
       ORDER BY created_at ASC`,
      [DRAFT],
    );
    printList(result.rows, log);
    return { action: "list", rows: result.rows };
  }

  if (command === "show") {
    const result = await db.query<DraftRow>(
      `SELECT id, slug, title, body, source, created_at
       FROM post_drafts
       WHERE id = $1`,
      [draftId],
    );
    if (result.rows.length === 0) {
      log.log(`not found: ${draftId}`);
    } else {
      printDraft(result.rows[0]!, log);
    }
    return { action: "show", rows: result.rows };
  }

  // posted | dismiss — dry-run by default, matching roast-moderate.ts.
  const targetStatus = command === "posted" ? "posted" : "dismissed";

  if (!apply) {
    const candidate = await db.query<DraftRow>(
      `SELECT id, slug, title, body, source, created_at
       FROM post_drafts
       WHERE id = $1 AND status = $2`,
      [draftId, DRAFT],
    );
    if (candidate.rows.length === 0) {
      log.log(`skipped: ${draftId} is not a pending draft or does not exist.`);
    } else {
      const row = candidate.rows[0]!;
      log.log(`dry-run: would mark ${row.id} (${row.slug}) as ${targetStatus}.`);
    }
    return { action: command, applied: false, rows: candidate.rows };
  }

  const result = await db.query<MutationRow>(
    `UPDATE post_drafts
     SET status = $2, resolved_at = now()
     WHERE id = $1 AND status = $3
     RETURNING id, slug`,
    [draftId, targetStatus, DRAFT],
  );
  if (result.rows.length === 0) {
    log.log(`skipped: ${draftId} is not a pending draft or does not exist.`);
  } else {
    const row = result.rows[0]!;
    log.log(`${targetStatus}: ${row.id} (${row.slug})`);
  }
  return { action: command, applied: true, rows: result.rows };
}

type ParsedArgs = {
  command: "list" | "show" | "posted" | "dismiss";
  draftId: string;
  apply: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, draftId] = argv.filter((a) => !a.startsWith("--"));
  const apply = argv.includes("--apply");
  if (command === "list") return { command, draftId: "", apply };
  if (command === "show" || command === "posted" || command === "dismiss") {
    if (draftId === undefined || draftId.length === 0) {
      throw new Error(`${command} requires a draft id`);
    }
    return { command, draftId, apply };
  }
  throw new Error("usage: post-queue.ts <list|show|posted|dismiss> [draft-id] [--apply]");
}

function printList(rows: DraftRow[], log: Pick<Console, "log">): void {
  if (rows.length === 0) {
    log.log("no pending drafts.");
    return;
  }
  log.log(`${rows.length} pending draft${rows.length === 1 ? "" : "s"}:\n`);
  for (const row of rows) {
    log.log(`— ${row.id}  [${row.source}]  ${toIso(row.created_at)}`);
    log.log(`  ${row.title}`);
    log.log(`  tweet: ${intentUrl(row.body)}\n`);
  }
}

function printDraft(row: DraftRow, log: Pick<Console, "log">): void {
  log.log(`id:      ${row.id}`);
  log.log(`slug:    ${row.slug}`);
  log.log(`source:  ${row.source}`);
  log.log(`created: ${toIso(row.created_at)}`);
  log.log(`title:   ${row.title}`);
  log.log(`\n${row.body}\n`);
  log.log(`tweet: ${intentUrl(row.body)}`);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is not set; populate apps/web/.env.local");
  }
  return databaseUrl;
}

function isDirectCliInvocation(): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href;
}

if (isDirectCliInvocation()) {
  runPostQueueCli().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}

export async function runPostQueueCli(argv = process.argv.slice(2)): Promise<void> {
  loadDotenv({ path: ".env.local", quiet: true });
  const { Pool } = await import("@neondatabase/serverless");
  const databaseUrl = requireDatabaseUrl();
  const host = databaseUrl.match(/@([^/]+)/)?.[1] ?? "(unknown)";
  // eslint-disable-next-line no-console
  console.log(`target host: ${host}`);

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await managePostQueue(argv, pool);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
