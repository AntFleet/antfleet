import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// Defense-in-depth policy check (Daybreak follow-up to PR #101/#103).
//
// repo_tier is operator-set only. The setter — setRepoCyberTier — lives
// in lib/cyber-tier-admin.ts and MUST NOT be imported by:
//   - webhooks
//   - install onboarding
//   - paid-rail (x402, ACP) flows
//   - any self-service settings UI
//
// The single allowed importer is the admin bearer-gated route at
// app/api/admin/repo/[owner]/[repo]/tier/route.ts. Tests are allowed
// too (so this test file can import its own surface).
//
// If you have a legitimate new caller, audit it carefully and add to
// ALLOWED_IMPORT_PATHS — but only if the new path enforces operator-only
// auth at its entry point. The whole point of this gate is to keep the
// mutation path narrow enough that a security reviewer can audit it in
// one sitting.

const ALLOWED_IMPORT_PATHS: ReadonlyArray<string> = [
  "apps/web/app/api/admin/repo/[owner]/[repo]/tier/route.ts",
  "apps/web/lib/cyber-tier-admin.test.ts",
];

describe("cyber-tier admin setter — operator-only enforcement", () => {
  test("setRepoCyberTier is only imported from the admin route + this test", () => {
    // Scan EVERY .ts/.tsx under apps/web for an import/require/dynamic-
    // import whose module specifier ends in `cyber-tier-admin` (with or
    // without `.ts` / `.tsx`). Catches all spellings:
    //   from "@/lib/cyber-tier-admin"
    //   from "@/lib/cyber-tier-admin.ts"
    //   from "./cyber-tier-admin"
    //   from "../lib/cyber-tier-admin"
    //   require("./cyber-tier-admin")
    //   import("../lib/cyber-tier-admin")
    // Fixed in audit pass-2 after pass-1 noted the prior exact-string
    // grep let relative imports bypass the guard. (Code + architect
    // audit pass-1, severity medium, test-gap / operator-contract.)
    const importPattern =
      /(?:from|require\(|import\()\s*["'][^"']*cyber-tier-admin(?:\.tsx?)?["']/u;
    const repoRoot = join(__dirname, "..", "..", "..");
    const webRoot = join(repoRoot, "apps", "web");
    const SKIP = new Set([".next", "node_modules", ".turbo", "dist", "build"]);
    const importers: string[] = [];

    function walk(dir: string): void {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP.has(entry)) continue;
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
          let body = "";
          try {
            body = readFileSync(full, "utf8");
          } catch {
            continue;
          }
          if (importPattern.test(body)) {
            importers.push(relative(repoRoot, full));
          }
        }
      }
    }

    walk(webRoot);

    // The setter file itself may be returned (future self-references);
    // allow it explicitly.
    const SELF = "apps/web/lib/cyber-tier-admin.ts";
    const unexpected = importers.filter((path) => {
      if (path === SELF) return false;
      return !ALLOWED_IMPORT_PATHS.includes(path);
    });

    expect(
      unexpected,
      `unexpected importer(s) of cyber-tier-admin: ${unexpected.join(", ")}`,
    ).toEqual([]);
  });

  test("write helpers are not re-exported from the read-side module", async () => {
    const readModule = (await import("./cyber-tier")) as Record<string, unknown>;
    expect(readModule["setRepoCyberTier"]).toBeUndefined();
    expect(readModule["readRepoCyberTierIgnoringFlag"]).toBeUndefined();
    expect(readModule["loadRepoTierChangeLog"]).toBeUndefined();
  });

  test("no module mutates repo_tier directly outside the admin module", () => {
    // The setter-import guard only blocks `from "...cyber-tier-admin"`.
    // A future caller could bypass that by importing `repoTier` from
    // the public schema export and calling `db.insert(repoTier)` /
    // `db.update(repoTier)` / `db.delete(repoTier)` directly. This test
    // closes that loophole: it scans every .ts/.tsx under apps/web for
    // direct mutation patterns and fails unless the file is the admin
    // setter, a migration, or an explicit allow-list entry. (Architect
    // audit pass-5, severity medium, operator-contract.)
    // Mutation regex covers:
    //   - Drizzle-typed DML against the imported `repoTier` symbol
    //   - Direct SQL DML against `repo_tier`, `public.repo_tier`, and
    //     quoted `"repo_tier"` / `"public"."repo_tier"` forms
    //   - Drizzle-typed DML against ANY aliased import of `repoTier`
    //     (e.g. `import { repoTier as rt }`) — matched via a generic
    //     `.insert(rt)` shape paired with a separate import-alias scan
    //
    // Architect audit pass-7 medium: aliased schema imports and
    // schema-qualified SQL could bypass the simpler exact-spelling
    // form. The aliased-import detector below catches the first case;
    // the regex broadening here catches the second.
    const mutationPattern =
      /(\.(?:insert|update|delete)\(\s*repoTier\b|insert\s+into\s+(?:public\s*\.\s*)?"?repo_tier"?\b|update\s+(?:public\s*\.\s*)?"?repo_tier"?\b|delete\s+from\s+(?:public\s*\.\s*)?"?repo_tier"?\b)/iu;
    // Aliased import detection: any `repoTier as Foo` import means we
    // must scan for `.insert(Foo)` / `.update(Foo)` / `.delete(Foo)`.
    // The single allowed alias is none — we forbid aliasing repoTier
    // outside the admin module to keep the static scan tractable.
    const aliasImportPattern = /\brepoTier\s+as\s+\w+/u;
    const repoRootLocal = join(__dirname, "..", "..", "..");
    const webRootLocal = join(repoRootLocal, "apps", "web");
    const SKIP_DIRS = new Set([".next", "node_modules", ".turbo", "dist", "build"]);
    const ALLOWED_MUTATORS = new Set([
      "apps/web/lib/cyber-tier-admin.ts",
      "apps/web/lib/cyber-tier-admin.test.ts",
    ]);
    const offenders: string[] = [];

    function walk(dir: string): void {
      let entries: string[];
      try {
        entries = require("node:fs").readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        let st: { isDirectory(): boolean; isFile(): boolean };
        try {
          st = require("node:fs").statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full);
        } else if (st.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
          const rel = full.slice(repoRootLocal.length + 1);
          if (ALLOWED_MUTATORS.has(rel)) continue;
          // Migrations may reference repo_tier in DDL form; the regex
          // intentionally matches DML only (insert/update/delete), so
          // CREATE TABLE statements pass through.
          let body = "";
          try {
            body = require("node:fs").readFileSync(full, "utf8");
          } catch {
            continue;
          }
          if (mutationPattern.test(body)) offenders.push(rel);
          if (aliasImportPattern.test(body))
            offenders.push(`${rel} (repoTier aliased — forbid for guard tractability)`);
        }
      }
    }

    walk(webRootLocal);

    expect(
      offenders,
      `Direct repo_tier mutation found outside the admin module: ${offenders.join(", ")}. ` +
        `Route the write through lib/cyber-tier-admin.ts setRepoCyberTier().`,
    ).toEqual([]);
  });
});
