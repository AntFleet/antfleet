import type { Config } from "drizzle-kit";

const databaseUrl = process.env["DATABASE_URL"] ?? "";

export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
} satisfies Config;
