// Regression test for audit task T1.4 — Repair or retire the migration
// mechanism.
//
// The drizzle-kit pipeline (`db:generate` / `db:migrate` / `db:push`) was
// half-broken: 37 SQL files lived under db/migrations/, the journal stopped
// at 0031, snapshots stopped at 0009. If an operator ran any of those
// scripts against the shared prod Neon endpoint, drizzle-kit would try to
// reconcile ~26 migrations' worth of schema drift in one shot.
//
// The fix is to retire those package.json entry points entirely. The hand-
// written `apply-migration-XXXX.ts` scripts (gated by safety.ts /
// ALLOW_PROD_APPLY) are the one true path; the runbook lives at
// `audit/RUNBOOK-migrations.md`.
//
// This test fails BEFORE the fix (the keys exist) and passes AFTER. It is
// the structural guard that keeps anyone from silently re-adding the
// dangerous scripts later.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const selfDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(selfDir, "..", "..", "package.json");

type PackageJsonShape = {
  readonly scripts?: Readonly<Record<string, string>>;
};

function readPackageJson(): PackageJsonShape {
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("apps/web/package.json did not parse to an object");
  }
  return parsed as PackageJsonShape;
}

describe("apps/web/package.json migration script surface", () => {
  const FORBIDDEN_SCRIPTS = ["db:generate", "db:migrate", "db:push"] as const;

  it.each(FORBIDDEN_SCRIPTS)("does not expose %s (retired by audit T1.4)", (scriptName) => {
    const pkg = readPackageJson();
    const scripts = pkg.scripts ?? {};
    expect(
      Object.prototype.hasOwnProperty.call(scripts, scriptName),
      `apps/web/package.json must not expose "${scriptName}". ` +
        "drizzle-kit's generate/migrate/push would try to reconcile " +
        "schema drift against the shared prod Neon endpoint. Use the " +
        "hand-applier `apply-migration-XXXX.ts` scripts instead. See " +
        "audit/RUNBOOK-migrations.md.",
    ).toBe(false);
  });
});
