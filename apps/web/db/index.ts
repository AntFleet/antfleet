import type { NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

// Neon DB access is intentionally disabled here. apps/web's crons (notably
// /api/cron/review-jobs firing every minute) kept the Neon "Launch" compute
// endpoint awake around the clock, driving real ongoing spend on a project
// that isn't being actively developed. No Pool/WebSocket connection is ever
// opened by this module, so nothing routed through `db` can reach Neon.
//
// To restore live DB access: revert this commit.
export class DbDisabledError extends Error {
  constructor() {
    super(
      "Neon DB access is disabled (see apps/web/db/index.ts) to stop Neon billing. " +
        "Revert the commit that introduced this guard to restore connectivity.",
    );
    this.name = "DbDisabledError";
  }
}

function disabledDbProxy(): unknown {
  return new Proxy(function disabledDb() {}, {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return disabledDbProxy();
    },
    apply(): never {
      throw new DbDisabledError();
    },
  });
}

export const db = disabledDbProxy() as NeonDatabase<typeof schema>;
export { schema };
