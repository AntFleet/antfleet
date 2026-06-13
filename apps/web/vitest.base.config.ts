import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Shared base used by both vitest.config.ts (unit) and
// vitest.integration.config.ts (integration). Anything that should apply
// to BOTH suites (alias resolution, env setup, mock restoration, timeout)
// belongs here; suite-specific include/exclude lives in the wrappers.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    restoreMocks: true,
    testTimeout: 30_000,
    // db/index.ts throws at import-time if DATABASE_URL is missing — and the
    // sweep orchestrator (slice 3-5) imports queries at the top level for
    // its REAL_DEPS factory. Tests inject mocks for every DB call, so the
    // string value is unused at runtime; we just need the throw to not fire.
    setupFiles: ["./test/setup-env.ts"],
  },
});
