import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { NextConfig } from "next";

// Lock turbopack to the AntFleet workspace root so it doesn't drift to a
// parent pnpm-lock.yaml that lives outside the repo.
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const config: NextConfig = {
  reactStrictMode: true,
  turbopack: { root: workspaceRoot },
};

export default config;
