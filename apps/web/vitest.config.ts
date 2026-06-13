import { mergeConfig } from "vitest/config";
import baseConfig from "./vitest.base.config";

export default mergeConfig(baseConfig, {
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // Exclude *.integration.test.ts from the default unit run — those tests
    // touch real sockets / processes and run under the separate
    // `test:integration` script (also wired into CI).
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/*.integration.test.ts",
      "**/*.integration.test.tsx",
    ],
  },
});
