import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("DATABASE_URL is required; set it via Vercel Marketplace (Neon) or .env.local");
}

const sql = neon(databaseUrl);
export const db = drizzle(sql, { schema });
export { schema };
