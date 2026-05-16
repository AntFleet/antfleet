import { config as loadDotenv } from "dotenv";
import type { Config } from "drizzle-kit";

// drizzle-kit runs outside Next.js, so .env.local isn't auto-loaded.
loadDotenv({ path: ".env.local", quiet: true });

const databaseUrl = process.env["DATABASE_URL"] ?? "";

export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
} satisfies Config;
