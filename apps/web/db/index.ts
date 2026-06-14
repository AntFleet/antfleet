import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// Why neon-serverless (Pool over WebSocket) instead of neon-http?
//
// The HTTP driver issues one fetch per query and has no notion of a
// connection — which means it cannot serve `db.transaction()`. Several
// queries DO require atomicity (recordFindingStatuses in db/queries.ts
// being the load-bearing one for the review-comment posting path) and
// throw `No transactions support in neon-http driver` under load,
// silently dropping comment posts across the entire reviews pipeline.
//
// neon-serverless uses WebSockets to a real Postgres connection, so
// BEGIN/COMMIT semantics work. All app routes that touch `db` already
// declare `export const runtime = "nodejs"` so WebSocket lifecycle and
// the Node-only `ws` polyfill below are safe.

const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required; set it via Vercel Marketplace (Neon) or .env.local");
}

// Node v22+ exposes a built-in WebSocket global; older runtimes (CI
// workers, local tsx on Node 21 / 20 LTS) need an explicit constructor.
// Importing `ws` lazily keeps the bundle clean when the native exists.
if (typeof globalThis.WebSocket === "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ws = require("ws");
  neonConfig.webSocketConstructor = ws;
}

const pool = new Pool({ connectionString: databaseUrl });
pool.on("error", (err: Error) => {
  // Pool errors typically mean a back-end disconnect (Neon scale-to-zero,
  // network blip). The connection self-heals on next use; we surface the
  // event so it shows up in logs for capacity diagnosis but never throw
  // from the listener — an unhandled emit would crash the function.
  console.error("[db] pool error:", err);
});

export const db = drizzle(pool, { schema });
export { schema };
