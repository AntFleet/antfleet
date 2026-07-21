import { logDebug, logWarn, messageOf } from "./log";

// DB sink for post drafts — the production counterpart of the file sink in
// post-drafts.ts (ANTFLEET_DRAFTS_DIR is unset on Vercel's read-only
// filesystem, so without this table every production draft was dropped).
//
// Contract mirrors writePostDraft: best-effort, never throws. Callers sit
// inside cron/webhook workers where a thrown sink has historically corrupted
// unrelated state (see the incident note in post-drafts.ts).

export type PostDraftDbRow = {
  slug: string;
  title: string;
  body: string;
  source: string;
};

export async function insertPostDraftRow(row: PostDraftDbRow): Promise<boolean> {
  // Unit runs inject a fake localhost DATABASE_URL (test/setup-env.ts); the
  // neon-serverless WebSocket connect against it can hang rather than fail
  // fast, so the sink is inert under vitest. Suites that exercise the sink
  // mock this module.
  if (process.env["VITEST"] !== undefined) {
    logDebug("post_draft.db_skipped", { reason: "vitest", slug: row.slug });
    return false;
  }
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    logDebug("post_draft.db_skipped", { reason: "DATABASE_URL_unset", slug: row.slug });
    return false;
  }
  try {
    // Lazy import: db/index.ts throws at module load when DATABASE_URL is
    // unset, so it must not be a static dependency of this best-effort path.
    const { db, schema } = await import("../db/index");
    // The partial unique index post_drafts_pending_slug_uniq makes a
    // re-fired event with a still-pending draft a no-op instead of a spam
    // row; onConflictDoNothing absorbs that conflict silently.
    await db.insert(schema.postDrafts).values(row).onConflictDoNothing();
    return true;
  } catch (err) {
    logWarn("post_draft.db_write_failed", { slug: row.slug, message: messageOf(err) });
    return false;
  }
}
