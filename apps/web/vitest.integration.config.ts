import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.base.config";

// Integration tests touch real sockets / processes (e.g. spinning up a
// local HTTP server to exercise undici dispatchers). They live under
// *.integration.test.ts and are excluded from the default unit run; run
// them with `pnpm test:integration`. CI wires them in as a separate step
// after the unit suite.
export default mergeConfig(baseConfig, {
  test: {
    include: ["**/*.integration.test.ts", "**/*.integration.test.tsx"],
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
});
