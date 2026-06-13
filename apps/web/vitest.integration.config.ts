import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests touch real sockets / processes (e.g. spinning up a
// local HTTP server to exercise undici dispatchers). They live under
// *.integration.test.ts and are excluded from the default unit run; run
// them with `pnpm test:integration`. CI wires them in as a separate step
// after the unit suite.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    include: ["**/*.integration.test.ts", "**/*.integration.test.tsx"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    restoreMocks: true,
    testTimeout: 30_000,
    setupFiles: ["./test/setup-env.ts"],
  },
});
