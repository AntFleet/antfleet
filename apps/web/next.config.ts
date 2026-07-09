import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NextConfig } from "next";

// Lock turbopack to the AntFleet workspace root so it doesn't drift to a
// parent pnpm-lock.yaml that lives outside the repo.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: workspaceRoot },
  // `scripts/` holds one-off operator CLI tools that aren't part of the
  // deployed app. They're still fully type-checked in CI via `pnpm
  // typecheck` (tsconfig.json, against a clean git checkout) — this only
  // keeps an uncommitted, still-broken script from blocking a manual
  // `vercel --prod` deploy of the app itself.
  typescript: { tsconfigPath: "./tsconfig.build.json" },
};

export default config;
