import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror the `@/*` alias declared in tsconfig.json. Tests that import
  // app/api/... route modules need this at runtime because Next.js
  // resolves the alias via its own webpack/turbopack config, not via tsc.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    restoreMocks: true,
    testTimeout: 30_000,
    // db/index.ts throws at import-time if DATABASE_URL is missing — and the
    // sweep orchestrator (slice 3-5) imports queries at the top level for
    // its REAL_DEPS factory. Tests inject mocks for every DB call, so the
    // string value is unused at runtime; we just need the throw to not fire.
    setupFiles: ["./test/setup-env.ts"],
  },
});
