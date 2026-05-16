import { defineConfig } from "vitest/config";

export default defineConfig({
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
