import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NextConfig } from "next";

// Lock turbopack to the AntFleet workspace root so it doesn't drift to a
// parent pnpm-lock.yaml that lives outside the repo.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: workspaceRoot },
  // The /changelog page reads CHANGELOG.md from the repo root (two levels
  // up from apps/web). Vercel's serverless bundler doesn't trace files
  // outside apps/web by default — this opt-in pulls the file into the
  // function bundle so the runtime readFile() works.
  outputFileTracingIncludes: {
    "/changelog": ["../../CHANGELOG.md"],
  },
};

export default config;

